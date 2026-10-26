// Objectives (missions, achievements, event goals) progress per period, and the daily login calendar. Written only by
// the objectives module.
import { sql } from "drizzle-orm";
import { bigint, char, datetime, int, mysqlTable, primaryKey, varchar } from "drizzle-orm/mysql-core";

import { users } from "./accounts.schema.js";

const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

/** Progress of one objective in one period (D:yyyy-mm-dd, W:yyyy-mm-dd (Monday), E:eventId, A for achievements). */
export const userObjectives = mysqlTable("user_objectives", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  objectiveId: varchar("objective_id", { length: 64 }).notNull(),
  period: varchar("period", { length: 80 }).notNull(),
  progress: bigint("progress", { mode: "number" }).notNull().default(0),
  claimedAt: datetime("claimed_at"),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.objectiveId, t.period] }),
]);

/** Daily login calendar: how many days were claimed and the UTC day of the last claim. */
export const userDailyRewards = mysqlTable("user_daily_rewards", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  step: int("step").notNull().default(0),
  lastClaimDay: char("last_claim_day", { length: 10 }),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
});
