import { and, eq, inArray, sql } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { towerProgress } from "../../infrastructure/database/schema/tower.schema.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";

/** Persistence port of the event towers' progress. */
export interface TowerRepository {
  /** Highest floor cleared of each tower the player has progress in (towers without a row are absent). */
  highestCleared(userId: string, towerIds: readonly string[], session?: DbSession): Promise<Map<string, number>>;
  /** Makes sure the row exists, then locks and reads it (inside a transaction): concurrent results of a player queue here. */
  lockProgress(userId: string, towerId: string, session: DbSession): Promise<number>;
  save(userId: string, towerId: string, highestCleared: number, session: DbSession): Promise<void>;
}

export class DrizzleTowerRepository extends DrizzleRepository implements TowerRepository {
  async highestCleared(userId: string, towerIds: readonly string[], session?: DbSession): Promise<Map<string, number>> {
    if (towerIds.length === 0) return new Map();
    const rows = await this.db(session).select({ towerId: towerProgress.towerId, highest: towerProgress.highestCleared }).from(towerProgress)
      .where(and(eq(towerProgress.userId, userId), inArray(towerProgress.towerId, [...towerIds])));
    return new Map(rows.map((row) => [row.towerId, row.highest]));
  }

  async lockProgress(userId: string, towerId: string, session: DbSession): Promise<number> {
    // Insert-if-missing first, so the row exists to be locked (a lock on a missing row would not serialize two first clears).
    await this.db(session).insert(towerProgress).values({ userId, towerId, highestCleared: 0 })
      .onDuplicateKeyUpdate({ set: { highestCleared: sql`${towerProgress.highestCleared}` } });
    const rows = await this.db(session).select({ highest: towerProgress.highestCleared }).from(towerProgress)
      .where(and(eq(towerProgress.userId, userId), eq(towerProgress.towerId, towerId))).limit(1).for("update");
    return rows[0]?.highest ?? 0;
  }

  async save(userId: string, towerId: string, highestCleared: number, session: DbSession): Promise<void> {
    await this.db(session).update(towerProgress).set({ highestCleared })
      .where(and(eq(towerProgress.userId, userId), eq(towerProgress.towerId, towerId)));
  }
}
