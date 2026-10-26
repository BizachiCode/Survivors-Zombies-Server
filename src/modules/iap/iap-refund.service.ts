// Refunds: when a store gives the money back (Apple REFUND/REVOKE notification, Google voided purchase, an admin's
// decision), what the purchase granted is taken back from the player. Idempotent per store transaction. Only what the
// player still has is taken (currencies and items never go below zero); the rest is recorded as the purchase's
// `refund_shortfall` (experience and levels are never revoked) and logged for support. The player gets a mail saying why.

import { createHash } from "node:crypto";

import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { createLogger } from "../../shared/logger.js";
import type { BattleCatalog } from "../battle/content/battle-content.js";
import type { InventoryLedger } from "../collection/inventory-ledger.js";
import { debitUpTo, isEmptyHoldings } from "../economy/debit-up-to.js";
import type { RewardBundle } from "../economy/reward-granter.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import type { MailService } from "../mail/mail.service.js";
import type { IapPurchaseRow, IapRepository, RefundShortfall } from "./iap.repository.js";
import type { IapStore } from "./validators/receipt.js";

const log = createLogger("iap-refund");

const MAIL_LIFETIME_MS = 90 * 86_400_000;

export type RefundOutcome =
  | { status: "refunded"; userId: string; productId: string; taken: RewardBundle; shortfall: RefundShortfall }
  | { status: "already_refunded"; userId: string; productId: string; shortfall: RefundShortfall | null }
  /** No purchase with that transaction id was ever recorded (nothing to revoke). */
  | { status: "unknown" };

export class IapRefundService {
  constructor(
    private readonly catalog: BattleCatalog,
    private readonly purchases: IapRepository,
    private readonly wallets: WalletLedger,
    private readonly inventory: InventoryLedger,
    private readonly mail: MailService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /** `reason` is stored with the purchase (apple_refund, google_voided..., admin:<text>). */
  async refund(store: IapStore, transactionId: string, reason: string): Promise<RefundOutcome> {
    const transactionKey = createHash("sha256").update(transactionId).digest("hex");
    const outcome = await this.uow.transaction(async (session): Promise<RefundOutcome> => {
      const row = await this.purchases.find(store, transactionKey, session, true);
      if (!row) return { status: "unknown" };
      if (row.status === "refunded") return { status: "already_refunded", userId: row.userId, productId: row.productId, shortfall: row.refundShortfall };

      const { taken, shortfall } = await debitUpTo(
        { wallets: this.wallets, inventory: this.inventory, knownItem: (itemId) => this.catalog.items.has(itemId) },
        session, row.userId, row.granted, "IAP_REFUND",
      );
      const missing: RefundShortfall = { currencies: shortfall.currencies, items: shortfall.items, exp: row.granted.exp ?? 0 };
      await this.purchases.markRefunded(row.id, this.clock.now(), reason, missing, session);
      await this.mail.send(session, row.userId, this.refundMail(row));
      return {
        status: "refunded",
        userId: row.userId,
        productId: row.productId,
        taken: { currencies: taken.currencies, items: taken.items, exp: 0 },
        shortfall: missing,
      };
    });

    if (outcome.status === "refunded") {
      const lost = !isEmptyHoldings(outcome.shortfall) ? ` NOT taken back (already spent): ${JSON.stringify({ currencies: outcome.shortfall.currencies, items: outcome.shortfall.items })}` : "";
      log.warn(`refunded ${outcome.productId} of ${outcome.userId} (${store}, ${reason}); taken ${JSON.stringify({ currencies: outcome.taken.currencies, items: outcome.taken.items })}.${lost}`);
    }
    return outcome;
  }

  private refundMail(row: IapPurchaseRow) {
    const product = this.catalog.shop?.product(row.productId)?.name ?? row.productId;
    return {
      sender: "Support",
      title: {
        en: "Purchase refunded", pt: "Compra reembolsada", es: "Compra reembolsada",
        zh: "购买已退款", ja: "購入が返金されました", ko: "구매 환불 안내",
      },
      body: {
        en: `Your purchase "${product}" was refunded by the store, so what it gave you was taken back from your account.`,
        pt: `Sua compra "${product}" foi reembolsada pela loja, então o que ela concedeu foi retirado da sua conta.`,
        es: `Tu compra "${product}" fue reembolsada por la tienda, por lo que lo que te dio se retiró de tu cuenta.`,
        zh: `你的购买“${product}”已被商店退款，因此其发放的内容已从你的账号中收回。`,
        ja: `ご購入の「${product}」はストアで返金されたため、付与された内容をアカウントから回収しました。`,
        ko: `구매하신 "${product}" 상품이 스토어에서 환불되어 지급된 항목이 계정에서 회수되었습니다.`,
      },
      expiresAt: new Date(this.clock.nowMs() + MAIL_LIFETIME_MS),
    };
  }
}
