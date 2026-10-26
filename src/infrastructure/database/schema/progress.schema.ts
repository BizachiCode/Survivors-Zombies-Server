// Campaign progress (best result per stage) and the history of finished battles.
import { sql } from "drizzle-orm";
import { char, datetime, index, int, json, mysqlTable, primaryKey, varchar } from "drizzle-orm/mysql-core";

import { users } from "./accounts.schema.js";

const now = sql`CURRENT_TIMESTAMP`;
const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

/** One row per stage the player has finished at least once. Written only by the battle service. */
export const userStageProgress = mysqlTable("user_stage_progress", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  stageId: varchar("stage_id", { length: 64 }).notNull(),
  bestStars: int("best_stars").notNull().default(0),
  wins: int("wins").notNull().default(0),
  plays: int("plays").notNull().default(0),
  /** Fastest victory, in battle milliseconds (null until the first win). */
  bestTimeMs: int("best_time_ms"),
  firstClearedAt: datetime("first_cleared_at"),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.stageId] }),
]);

/**
 * Every finished battle (victory, defeat or abandoned), keyed by the battle id the server issued: the primary key makes
 * a battle's reward impossible to grant twice. Kept for support and cheat investigation.
 */
export const battleResults = mysqlTable("battle_results", {
  id: char("id", { length: 36 }).primaryKey().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Battle mode (campaign, arena, tower...). */
  mode: varchar("mode", { length: 16 }).notNull().default("campaign"),
  /** The stage, or the mode's stage-like id (e.g. arena:2026-10-19). */
  stageId: varchar("stage_id", { length: 64 }).notNull(),
  /** VICTORY | DEFEAT | ABANDONED */
  outcome: varchar("outcome", { length: 16 }).notNull(),
  stars: int("stars").notNull(),
  ticks: int("ticks").notNull(),
  kills: int("kills").notNull(),
  baseHealth: int("base_health").notNull(),
  /** Content hash of the simulated battle (which balance it ran with). */
  contentHash: char("content_hash", { length: 64 }).notNull(),
  /** Granted reward: { currencies, exp }. */
  reward: json("reward").notNull(),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_battle_results_user").on(t.userId, t.createdAt),
]);
