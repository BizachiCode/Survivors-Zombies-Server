import { and, count, desc, eq } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { iapPurchases } from "../../infrastructure/database/schema/iap.schema.js";
import { parseJsonColumn } from "../../shared/content/localized-text.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { RewardBundle } from "../economy/reward-granter.js";
import type { IapStore } from "./validators/receipt.js";

export type IapPurchaseStatus = "granted" | "refunded";

/** What a refund could not take back (the player had already spent it); `exp` is never revoked. */
export type RefundShortfall = { currencies: Record<string, number>; items: Record<string, number>; exp: number };

export type IapPurchaseRow = {
  id: string;
  userId: string;
  store: IapStore;
  transactionKey: string;
  transactionId: string;
  orderId: string;
  productId: string;
  storeProductId: string;
  environment: string;
  quantity: number;
  granted: RewardBundle;
  purchasedAt: Date;
  status: IapPurchaseStatus;
  refundedAt: Date | null;
  refundReason: string | null;
  refundShortfall: RefundShortfall | null;
};

/** Persistence port of verified purchases. */
export interface IapRepository {
  /** Inserts the purchase; false when the (store, transaction) already exists. */
  insert(row: IapPurchaseRow, session: DbSession): Promise<boolean>;
  /** `forUpdate` (inside a transaction) locks the row. */
  find(store: IapStore, transactionKey: string, session?: DbSession, forUpdate?: boolean): Promise<IapPurchaseRow | null>;
  /** Newest first. */
  listByUser(userId: string, limit: number, session?: DbSession): Promise<IapPurchaseRow[]>;
  /** Records the refund of a purchase (status `refunded`). */
  markRefunded(id: string, at: Date, reason: string, shortfall: RefundShortfall, session: DbSession): Promise<void>;
  /** Purchases per product of a player. */
  counts(userId: string, session?: DbSession): Promise<Map<string, number>>;
  setGranted(id: string, granted: RewardBundle, session: DbSession): Promise<void>;
}

type Stored = typeof iapPurchases.$inferSelect;

function toRow(row: Stored): IapPurchaseRow {
  return {
    id: row.id,
    userId: row.userId,
    store: row.store as IapStore,
    transactionKey: row.transactionKey,
    transactionId: row.transactionId,
    orderId: row.orderId,
    productId: row.productId,
    storeProductId: row.storeProductId,
    environment: row.environment,
    quantity: row.quantity,
    granted: parseJsonColumn<RewardBundle>(row.granted),
    purchasedAt: row.purchasedAt,
    status: row.status === "refunded" ? "refunded" : "granted",
    refundedAt: row.refundedAt,
    refundReason: row.refundReason,
    refundShortfall: row.refundShortfall === null || row.refundShortfall === undefined ? null : parseJsonColumn<RefundShortfall>(row.refundShortfall),
  };
}

export class DrizzleIapRepository extends DrizzleRepository implements IapRepository {
  async insert(row: IapPurchaseRow, session: DbSession): Promise<boolean> {
    try {
      await this.db(session).insert(iapPurchases).values({ ...row, granted: row.granted });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async find(store: IapStore, transactionKey: string, session?: DbSession, forUpdate = false): Promise<IapPurchaseRow | null> {
    const query = this.db(session).select().from(iapPurchases)
      .where(and(eq(iapPurchases.store, store), eq(iapPurchases.transactionKey, transactionKey))).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ? toRow(rows[0]) : null;
  }

  async listByUser(userId: string, limit: number, session?: DbSession): Promise<IapPurchaseRow[]> {
    const rows = await this.db(session).select().from(iapPurchases).where(eq(iapPurchases.userId, userId))
      .orderBy(desc(iapPurchases.purchasedAt)).limit(limit);
    return rows.map(toRow);
  }

  async markRefunded(id: string, at: Date, reason: string, shortfall: RefundShortfall, session: DbSession): Promise<void> {
    await this.db(session).update(iapPurchases)
      .set({ status: "refunded", refundedAt: at, refundReason: reason.slice(0, 255), refundShortfall: shortfall })
      .where(eq(iapPurchases.id, id));
  }

  async counts(userId: string, session?: DbSession): Promise<Map<string, number>> {
    const rows = await this.db(session).select({ productId: iapPurchases.productId, total: count() }).from(iapPurchases)
      .where(eq(iapPurchases.userId, userId)).groupBy(iapPurchases.productId);
    return new Map(rows.map((row) => [row.productId, Number(row.total)]));
  }

  async setGranted(id: string, granted: RewardBundle, session: DbSession): Promise<void> {
    await this.db(session).update(iapPurchases).set({ granted }).where(eq(iapPurchases.id, id));
  }
}
