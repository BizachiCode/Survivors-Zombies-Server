// Shop use cases: the offers with what is left today, and buying one (price through WalletLedger, grants through
// WalletLedger + InventoryLedger, the daily count) in one transaction. Prices and grants come only from the content.

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { BattleCatalog } from "../battle/content/battle-content.js";
import type { InventoryLedger, ItemAmounts } from "../collection/inventory-ledger.js";
import type { WalletDto, WalletLedger } from "../economy/wallet-ledger.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import type { ShopCatalog, ShopOffer } from "./shop-content.js";
import type { ShopRepository } from "./shop.repository.js";
import { NO_RECORDER, type ObjectiveRecorder } from "../objectives/objectives.service.js";

export type OfferDto = Omit<ShopOffer, "requiredLevel"> & {
  requiredLevel: number;
  /** Purchases left today; null = unlimited. */
  remaining: number | null;
  /** Level reached and (when limited) purchases left. */
  available: boolean;
};

export type ShopDto = {
  enabled: boolean;
  offers: OfferDto[];
  /** When the daily limits reset (next UTC midnight). */
  resetsAtUnix: number;
  wallet: WalletDto;
  items: ItemAmounts;
};

/** UTC day of a moment, YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class ShopService {
  constructor(
    private readonly catalog: BattleCatalog,
    private readonly purchases: ShopRepository,
    private readonly wallets: WalletLedger,
    private readonly inventory: InventoryLedger,
    private readonly profiles: ProfileRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly recorder: ObjectiveRecorder = NO_RECORDER,
  ) {}

  private get shop(): ShopCatalog {
    const shop = this.catalog.shop;
    if (!shop) throw new AppError(ErrorCode.SHOP_DISABLED);
    return shop;
  }

  async info(userId: string): Promise<ShopDto> {
    if (!this.catalog.shop) {
      return { enabled: false, offers: [], resetsAtUnix: this.resetsAt(), wallet: await this.wallets.snapshot(userId), items: await this.inventory.snapshot(userId) };
    }
    return this.snapshot(userId);
  }

  /** Buys one offer: pays its price, grants its contents, counts it for today. */
  async buy(userId: string, offerId: string): Promise<ShopDto> {
    const offer = this.shop.offer(offerId);
    if (!offer) throw new AppError(ErrorCode.SHOP_OFFER_UNKNOWN);
    const day = utcDay(this.clock.nowMs());
    await this.uow.transaction(async (session) => {
      const level = (await this.profiles.getProfile(userId, session))?.level ?? 1;
      if (level < offer.requiredLevel) throw new AppError(ErrorCode.SHOP_LOCKED, { extra: { requiredLevel: offer.requiredLevel } });
      const count = await this.purchases.lockCount(userId, offer.id, day, session);
      if (offer.dailyLimit > 0 && count >= offer.dailyLimit) throw new AppError(ErrorCode.SHOP_LIMIT_REACHED, { extra: { dailyLimit: offer.dailyLimit } });
      if (offer.price.amount > 0) await this.wallets.debit(session, userId, { [offer.price.currency]: offer.price.amount }, "SHOP_PURCHASE");
      if (Object.keys(offer.grants.currencies).length > 0) await this.wallets.credit(session, userId, offer.grants.currencies, "SHOP_PURCHASE");
      if (Object.keys(offer.grants.items).length > 0) await this.inventory.credit(session, userId, { ...offer.grants.items }, "SHOP_PURCHASE");
      await this.purchases.saveCount(userId, offer.id, day, count + 1, session);
      await this.recorder.record(session, userId, {
        shop_purchases: 1, coins_spent: offer.price.currency === "coins" ? offer.price.amount : 0, gems_spent: offer.price.currency === "gems" ? offer.price.amount : 0,
      });
    });
    return this.snapshot(userId);
  }

  private async snapshot(userId: string): Promise<ShopDto> {
    const counts = await this.purchases.countsOn(userId, utcDay(this.clock.nowMs()));
    const level = (await this.profiles.getProfile(userId))?.level ?? 1;
    const offers = this.shop.offers.map((offer): OfferDto => {
      const remaining = offer.dailyLimit > 0 ? Math.max(0, offer.dailyLimit - (counts.get(offer.id) ?? 0)) : null;
      return { ...offer, remaining, available: level >= offer.requiredLevel && (remaining === null || remaining > 0) };
    });
    return { enabled: true, offers, resetsAtUnix: this.resetsAt(), wallet: await this.wallets.snapshot(userId), items: await this.inventory.snapshot(userId) };
  }

  private resetsAt(): number {
    const now = new Date(this.clock.nowMs());
    return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000);
  }
}
