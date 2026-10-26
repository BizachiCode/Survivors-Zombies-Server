// Arena: each player's league and tickets, the groups of a season (players of one league compete in groups of a fixed
// size) and each player's entry in a season (group, best score, settlement). Written only by the arena service.
import { sql } from "drizzle-orm";
import { char, datetime, index, int, mysqlTable, primaryKey } from "drizzle-orm/mysql-core";

import { users } from "./accounts.schema.js";

const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

export const arenaPlayers = mysqlTable("arena_players", {
  userId: char("user_id", { length: 36 }).primaryKey().references(() => users.id, { onDelete: "cascade" }),
  leagueIndex: int("league_index").notNull().default(0),
  tickets: int("tickets").notNull(),
  /** When `tickets` was counted (regeneration runs from here). */
  ticketsAt: datetime("tickets_at").notNull(),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
});

export const arenaGroups = mysqlTable("arena_groups", {
  id: char("id", { length: 36 }).primaryKey(),
  /** Monday of the season, YYYY-MM-DD (UTC). */
  seasonId: char("season_id", { length: 10 }).notNull(),
  leagueIndex: int("league_index").notNull(),
  members: int("members").notNull().default(0),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  index("arena_groups_open").on(t.seasonId, t.leagueIndex, t.members),
]);

export const arenaEntries = mysqlTable("arena_entries", {
  seasonId: char("season_id", { length: 10 }).notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  groupId: char("group_id", { length: 36 }).notNull(),
  /** League the player competed in this season. */
  leagueIndex: int("league_index").notNull(),
  bestScore: int("best_score").notNull().default(0),
  /** When the best score was reached (ties rank the earlier first); null before any score. */
  bestAt: datetime("best_at", { fsp: 3 }),
  plays: int("plays").notNull().default(0),
  /** End of season processed (league change, reward mail). */
  settledAt: datetime("settled_at"),
}, (t) => [
  primaryKey({ columns: [t.seasonId, t.userId] }),
  index("arena_entries_group").on(t.groupId, t.bestScore),
  index("arena_entries_user").on(t.userId, t.settledAt),
]);
