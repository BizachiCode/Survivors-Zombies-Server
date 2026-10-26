import { and, eq } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { shopPurchases } from "../../infrastructure/database/schema/index.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";

/** Persistence port of the shop's daily purchase counts. */
export interface ShopRepository {
  /** Purchases of every offer on `day` (UTC, YYYY-MM-DD). */
  countsOn(userId: string, day: string, session?: DbSession): Promise<Map<string, number>>;
  /** Locks and reads one offer's count (inside a transaction). */
  lockCount(userId: string, offerId: string, day: string, session: DbSession): Promise<number>;
  saveCount(userId: string, offerId: string, day: string, count: number, session: DbSession): Promise<void>;
}

export class DrizzleShopRepository extends DrizzleRepository implements ShopRepository {
  async countsOn(userId: string, day: string, session?: DbSession): Promise<Map<string, number>> {
    const rows = await this.db(session).select({ offerId: shopPurchases.offerId, count: shopPurchases.count }).from(shopPurchases)
      .where(and(eq(shopPurchases.userId, userId), eq(shopPurchases.day, day)));
    return new Map(rows.map((row) => [row.offerId, row.count]));
  }

  async lockCount(userId: string, offerId: string, day: string, session: DbSession): Promise<number> {
    const rows = await this.db(session).select({ count: shopPurchases.count }).from(shopPurchases)
      .where(and(eq(shopPurchases.userId, userId), eq(shopPurchases.offerId, offerId), eq(shopPurchases.day, day))).limit(1).for("update");
    return rows[0]?.count ?? 0;
  }

  async saveCount(userId: string, offerId: string, day: string, count: number, session: DbSession): Promise<void> {
    await this.db(session).insert(shopPurchases).values({ userId, offerId, day, count }).onDuplicateKeyUpdate({ set: { count } });
  }
}
