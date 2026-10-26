// Real-money purchases. The client buys through the platform store, then sends the receipt here; the server verifies it
// with the store's validator, finds the product, checks the receipt belongs to this account, and grants the product's
// content once per store transaction (unique key; a replayed receipt grants nothing). Only after the answer does the
// client confirm (consume) the purchase in the store, so a purchase is never lost between paying and granting.

import { createHash, randomUUID } from "node:crypto";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { createLogger } from "../../shared/logger.js";
import type { BattleCatalog } from "../battle/content/battle-content.js";
import type { InventoryLedger, ItemAmounts } from "../collection/inventory-ledger.js";
import { EMPTY_REWARD, isEmptyReward, type RewardBundle, type RewardGranter } from "../economy/reward-granter.js";
import type { WalletDto, WalletLedger } from "../economy/wallet-ledger.js";
import type { ProfileDto } from "../profile/profile.dto.js";
import { toProfileDto } from "../profile/profile.mapper.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import { ShopCatalog, type IapProduct, type IapProductKind } from "../shop/shop-content.js";
import type { IapPurchaseRow, IapRepository } from "./iap.repository.js";
import type { IapStore, ReceiptInput, ReceiptValidator, VerifiedPurchase } from "./validators/receipt.js";

const log = createLogger("iap");

export type IapProductDto = {
  id: string;
  name: string;
  kind: IapProductKind;
  storeIds: { google: string; apple: string };
  grants: RewardBundle;
  /** What the next purchase adds on top (empty once the product was bought). */
  firstPurchaseBonus: RewardBundle;
  /** 0 = unlimited. */
  limit: number;
  purchased: number;
  /** Level reached and limit not reached. */
  available: boolean;
  requiredLevel: number;
  tag: string;
  referencePrice: string;
};

export type IapCatalogDto = {
  enabled: boolean;
  /** IAP_TEST_MODE: the client buys without the platform store (test receipts of the `fake` store) and nothing is paid. */
  testMode: boolean;
  /** Stores this server verifies (the client hides the shop on others). */
  stores: IapStore[];
  products: IapProductDto[];
};

export type IapVerifyDto = IapCatalogDto & {
  productId: string;
  /** The store's id of the purchase (Google order id / Apple original transaction id) for support. */
  orderId: string;
  /** The receipt was already granted before (same account): nothing more was credited; the client can confirm it. */
  alreadyProcessed: boolean;
  granted: RewardBundle;
  levelsGained: number;
  wallet: WalletDto;
  items: ItemAmounts;
  profile: ProfileDto;
};

export type IapVerifyRequest = ReceiptInput & { store: IapStore; productId: string };

export type IapOptions = {
  /** Refuse store receipts that don't name the buyer's account (see accountToken). */
  requireAccountBinding: boolean;
  /** IAP_TEST_MODE: tell clients to send test purchases instead of using the platform store. */
  testMode?: boolean;
};

/** Account binding the client puts in purchases: Apple appAccountToken = the user id; Google obfuscatedAccountId = sha256(user id). */
export function accountTokenFor(store: IapStore, userId: string): string {
  return store === "google" ? createHash("sha256").update(userId).digest("hex") : userId.toLowerCase();
}

export class IapService {
  private readonly validators = new Map<IapStore, ReceiptValidator>();

  constructor(
    private readonly catalog: BattleCatalog,
    private readonly purchases: IapRepository,
    validators: readonly ReceiptValidator[],
    private readonly rewards: RewardGranter,
    private readonly wallets: WalletLedger,
    private readonly inventory: InventoryLedger,
    private readonly profiles: ProfileRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly options: IapOptions,
  ) {
    for (const validator of validators) this.validators.set(validator.store, validator);
  }

  private get products(): readonly IapProduct[] {
    return this.catalog.shop?.products ?? [];
  }

  async info(userId: string): Promise<IapCatalogDto> {
    const enabled = this.products.length > 0 && this.validators.size > 0;
    if (!enabled) return { enabled: false, testMode: false, stores: [], products: [] };
    const level = (await this.profiles.getProfile(userId))?.level ?? 1;
    const counts = await this.purchases.counts(userId);
    return {
      enabled,
      testMode: this.options.testMode === true && this.validators.has("fake"),
      stores: [...this.validators.keys()],
      products: this.products.map((product) => {
        const purchased = counts.get(product.id) ?? 0;
        const limit = ShopCatalog.limit(product);
        return {
          id: product.id,
          name: product.name,
          kind: product.kind,
          storeIds: { google: ShopCatalog.storeId(product, "google"), apple: ShopCatalog.storeId(product, "apple") },
          grants: product.grants,
          firstPurchaseBonus: purchased === 0 ? product.firstPurchaseBonus : EMPTY_REWARD,
          limit,
          purchased,
          available: level >= product.requiredLevel && (limit === 0 || purchased < limit),
          requiredLevel: product.requiredLevel,
          tag: product.tag,
          referencePrice: product.referencePrice,
        };
      }),
    };
  }

  /** Verifies a store receipt and grants its product once. */
  async verify(userId: string, request: IapVerifyRequest): Promise<IapVerifyDto> {
    if (this.products.length === 0) throw new AppError(ErrorCode.IAP_DISABLED);
    const validator = this.validators.get(request.store);
    if (!validator) throw new AppError(ErrorCode.IAP_STORE_UNSUPPORTED);

    const verified = await validator.verify({ receipt: request.receipt, jws: request.jws });
    const product = verified.store === "fake"
      // The fake store's receipt doesn't name the product: trust the request (development only).
      ? this.catalog.shop?.product(request.productId)
      : this.catalog.shop?.productForStore(verified.store, verified.storeProductId);
    if (!product) throw new AppError(ErrorCode.IAP_PRODUCT_UNKNOWN);
    this.checkAccount(verified, userId);

    const transactionKey = createHash("sha256").update(verified.transactionId).digest("hex");
    const outcome = await this.uow.transaction(async (session) => {
      const row: IapPurchaseRow = {
        id: randomUUID(),
        userId,
        store: verified.store,
        transactionKey,
        transactionId: verified.transactionId,
        orderId: verified.orderId.slice(0, 128),
        productId: product.id,
        storeProductId: verified.storeProductId,
        environment: verified.environment,
        quantity: verified.quantity,
        granted: EMPTY_REWARD,
        purchasedAt: new Date(verified.purchasedAtMs || this.clock.nowMs()),
        status: "granted",
        refundedAt: null,
        refundReason: null,
        refundShortfall: null,
      };
      if (!(await this.purchases.insert(row, session))) {
        const existing = await this.purchases.find(verified.store, transactionKey, session);
        if (!existing || existing.userId !== userId) throw new AppError(ErrorCode.IAP_ACCOUNT_MISMATCH);
        return { alreadyProcessed: true, granted: EMPTY_REWARD, levelsGained: 0, orderId: existing.orderId };
      }
      const earlier = ((await this.purchases.counts(userId, session)).get(product.id) ?? 1) - 1;
      const limit = ShopCatalog.limit(product);
      // The money was taken: a purchase over the limit (two devices at once) still grants, without the bonus.
      if (limit > 0 && earlier >= limit) log.warn(`purchase over the limit of ${product.id} by ${userId} (${verified.store} ${verified.orderId})`);
      // Same for the level: the shop hides the product below its Required Level, but a paid receipt is always granted.
      const level = (await this.profiles.getProfile(userId, session))?.level ?? 0;
      if (level < product.requiredLevel) log.warn(`purchase of ${product.id} below its required level ${product.requiredLevel} by ${userId} (level ${level})`);
      const granted = scale(product.grants, verified.quantity);
      if (earlier === 0) addInto(granted, product.firstPurchaseBonus);
      const { levelsGained } = await this.rewards.grant(session, userId, granted, "IAP_PURCHASE");
      await this.purchases.setGranted(row.id, granted, session);
      return { alreadyProcessed: false, granted, levelsGained, orderId: row.orderId };
    });

    if (!outcome.alreadyProcessed) log.info(`granted ${product.id} x${verified.quantity} to ${userId} (${verified.store}/${verified.environment} ${outcome.orderId})`);
    const profile = await this.profiles.getProfile(userId);
    if (!profile) throw new AppError(ErrorCode.UNAUTHORIZED);
    return {
      ...(await this.info(userId)),
      productId: product.id,
      orderId: outcome.orderId,
      alreadyProcessed: outcome.alreadyProcessed,
      granted: outcome.granted,
      levelsGained: outcome.levelsGained,
      wallet: await this.wallets.snapshot(userId),
      items: await this.inventory.snapshot(userId),
      profile: toProfileDto(profile),
    };
  }

  private checkAccount(verified: VerifiedPurchase, userId: string): void {
    if (verified.store === "fake") return;
    if (verified.accountToken === null) {
      if (this.options.requireAccountBinding) throw new AppError(ErrorCode.IAP_ACCOUNT_MISMATCH, { message: "receipt without account" });
      return;
    }
    if (verified.accountToken.toLowerCase() !== accountTokenFor(verified.store, userId)) throw new AppError(ErrorCode.IAP_ACCOUNT_MISMATCH);
  }
}

function scale(reward: RewardBundle, times: number): RewardBundle {
  const result: RewardBundle = { currencies: {}, items: {}, exp: reward.exp * times };
  for (const [id, value] of Object.entries(reward.currencies)) result.currencies[id as keyof RewardBundle["currencies"]] = (value ?? 0) * times;
  for (const [id, value] of Object.entries(reward.items)) result.items[id] = value * times;
  return result;
}

function addInto(target: RewardBundle, extra: RewardBundle): void {
  if (isEmptyReward(extra)) return;
  for (const [id, value] of Object.entries(extra.currencies)) {
    const key = id as keyof RewardBundle["currencies"];
    target.currencies[key] = (target.currencies[key] ?? 0) + (value ?? 0);
  }
  for (const [id, value] of Object.entries(extra.items)) target.items[id] = (target.items[id] ?? 0) + value;
  target.exp += extra.exp;
}
