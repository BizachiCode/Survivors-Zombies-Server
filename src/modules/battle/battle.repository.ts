import { and, eq } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { battleResults, userStageProgress } from "../../infrastructure/database/schema/index.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { Reward } from "./content/battle-content.js";
import type { BattleOutcomeKind } from "./battle-rules.js";

export type StageProgressRow = {
  userId: string;
  stageId: string;
  bestStars: number;
  wins: number;
  plays: number;
  bestTimeMs: number | null;
  firstClearedAt: Date | null;
};

export type BattleResultRow = {
  id: string;
  userId: string;
  mode: string;
  stageId: string;
  outcome: BattleOutcomeKind;
  stars: number;
  ticks: number;
  kills: number;
  baseHealth: number;
  contentHash: string;
  reward: Reward;
};

/** Persistence port of campaign progress and battle results. */
export interface BattleRepository {
  listProgress(userId: string, session?: DbSession): Promise<StageProgressRow[]>;
  /** `forUpdate` (inside a transaction) locks the row. */
  getProgress(userId: string, stageId: string, session: DbSession, forUpdate?: boolean): Promise<StageProgressRow | null>;
  saveProgress(row: StageProgressRow, session: DbSession): Promise<void>;
  /** Inserts a result; a battle id that was already recorded throws a duplicate-key error. */
  insertResult(row: BattleResultRow, session: DbSession): Promise<void>;
  /** Stars and reward decided after the row was inserted. */
  updateResult(battleId: string, stars: number, reward: Reward, session: DbSession): Promise<void>;
  getResult(battleId: string, session?: DbSession): Promise<BattleResultRow | null>;
}

const progressColumns = {
  userId: userStageProgress.userId,
  stageId: userStageProgress.stageId,
  bestStars: userStageProgress.bestStars,
  wins: userStageProgress.wins,
  plays: userStageProgress.plays,
  bestTimeMs: userStageProgress.bestTimeMs,
  firstClearedAt: userStageProgress.firstClearedAt,
};

export class DrizzleBattleRepository extends DrizzleRepository implements BattleRepository {
  async listProgress(userId: string, session?: DbSession): Promise<StageProgressRow[]> {
    return this.db(session).select(progressColumns).from(userStageProgress).where(eq(userStageProgress.userId, userId));
  }

  async getProgress(userId: string, stageId: string, session: DbSession, forUpdate = false): Promise<StageProgressRow | null> {
    const query = this.db(session).select(progressColumns).from(userStageProgress)
      .where(and(eq(userStageProgress.userId, userId), eq(userStageProgress.stageId, stageId))).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ?? null;
  }

  async saveProgress(row: StageProgressRow, session: DbSession): Promise<void> {
    const { userId, stageId, ...values } = row;
    await this.db(session).insert(userStageProgress).values(row).onDuplicateKeyUpdate({ set: values });
  }

  async insertResult(row: BattleResultRow, session: DbSession): Promise<void> {
    await this.db(session).insert(battleResults).values(row);
  }

  async updateResult(battleId: string, stars: number, reward: Reward, session: DbSession): Promise<void> {
    await this.db(session).update(battleResults).set({ stars, reward }).where(eq(battleResults.id, battleId));
  }

  async getResult(battleId: string, session?: DbSession): Promise<BattleResultRow | null> {
    const rows = await this.db(session).select().from(battleResults).where(eq(battleResults.id, battleId)).limit(1);
    const row = rows[0];
    // MariaDB keeps JSON columns as LONGTEXT, so the driver may hand back the raw text.
    return row ? { ...row, outcome: row.outcome as BattleOutcomeKind, reward: (typeof row.reward === "string" ? JSON.parse(row.reward) : row.reward) as Reward } : null;
  }
}
