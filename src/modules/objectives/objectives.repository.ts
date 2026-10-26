import { and, eq, inArray, sql } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userDailyRewards, userObjectives } from "../../infrastructure/database/schema/index.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";

export type ObjectiveProgressRow = { objectiveId: string; period: string; progress: number; claimedAt: Date | null };
export type DailyRewardRow = { userId: string; step: number; lastClaimDay: string | null };

/** Persistence port of objective progress and the daily login calendar. */
export interface ObjectivesRepository {
  /** Rows of the given periods. */
  listProgress(userId: string, periods: readonly string[], session?: DbSession): Promise<ObjectiveProgressRow[]>;
  /** Adds `delta` to each (objective, period), creating rows as needed. */
  increment(userId: string, entries: readonly { objectiveId: string; period: string; delta: number }[], session: DbSession): Promise<void>;
  /** Locks and reads one row (inside a transaction). */
  lockProgress(userId: string, objectiveId: string, period: string, session: DbSession): Promise<ObjectiveProgressRow | null>;
  markClaimed(userId: string, objectiveId: string, period: string, at: Date, session: DbSession): Promise<void>;
  getDaily(userId: string, session?: DbSession, forUpdate?: boolean): Promise<DailyRewardRow | null>;
  saveDaily(row: DailyRewardRow, session: DbSession): Promise<void>;
}

const progressColumns = {
  objectiveId: userObjectives.objectiveId, period: userObjectives.period, progress: userObjectives.progress, claimedAt: userObjectives.claimedAt,
};

export class DrizzleObjectivesRepository extends DrizzleRepository implements ObjectivesRepository {
  async listProgress(userId: string, periods: readonly string[], session?: DbSession): Promise<ObjectiveProgressRow[]> {
    if (periods.length === 0) return [];
    return this.db(session).select(progressColumns).from(userObjectives)
      .where(and(eq(userObjectives.userId, userId), inArray(userObjectives.period, [...periods])));
  }

  async increment(userId: string, entries: readonly { objectiveId: string; period: string; delta: number }[], session: DbSession): Promise<void> {
    for (const entry of entries) {
      await this.db(session).insert(userObjectives)
        .values({ userId, objectiveId: entry.objectiveId, period: entry.period, progress: entry.delta })
        .onDuplicateKeyUpdate({ set: { progress: sql`${userObjectives.progress} + ${entry.delta}` } });
    }
  }

  async lockProgress(userId: string, objectiveId: string, period: string, session: DbSession): Promise<ObjectiveProgressRow | null> {
    const rows = await this.db(session).select(progressColumns).from(userObjectives)
      .where(and(eq(userObjectives.userId, userId), eq(userObjectives.objectiveId, objectiveId), eq(userObjectives.period, period)))
      .limit(1).for("update");
    return rows[0] ?? null;
  }

  async markClaimed(userId: string, objectiveId: string, period: string, at: Date, session: DbSession): Promise<void> {
    await this.db(session).update(userObjectives).set({ claimedAt: at })
      .where(and(eq(userObjectives.userId, userId), eq(userObjectives.objectiveId, objectiveId), eq(userObjectives.period, period)));
  }

  async getDaily(userId: string, session?: DbSession, forUpdate = false): Promise<DailyRewardRow | null> {
    const query = this.db(session).select({ userId: userDailyRewards.userId, step: userDailyRewards.step, lastClaimDay: userDailyRewards.lastClaimDay })
      .from(userDailyRewards).where(eq(userDailyRewards.userId, userId)).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ?? null;
  }

  async saveDaily(row: DailyRewardRow, session: DbSession): Promise<void> {
    await this.db(session).insert(userDailyRewards).values(row)
      .onDuplicateKeyUpdate({ set: { step: row.step, lastClaimDay: row.lastClaimDay } });
  }
}
