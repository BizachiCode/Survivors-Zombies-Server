// Clans: the clan itself, its members (one clan per player), pending join requests and token donations. Written only
// by the clans service. The uniques keep the invariants under races: one clan per player, one pending join request per
// player, unique tag and unique name (case-insensitive through `name_key`).
import { sql } from "drizzle-orm";
import { char, datetime, index, int, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

import { users } from "./accounts.schema.js";

const now = sql`CURRENT_TIMESTAMP`;

export const clans = mysqlTable("clans", {
  id: char("id", { length: 36 }).primaryKey().notNull(),
  /** Public tag: 6 characters of the unambiguous base32 alphabet. */
  tag: char("tag", { length: 6 }).notNull(),
  name: varchar("name", { length: 20 }).notNull(),
  /** Lower-cased name: the unique key that makes names case-insensitively unique whatever the collation. */
  nameKey: varchar("name_key", { length: 20 }).notNull(),
  description: varchar("description", { length: 140 }).notNull().default(""),
  badge: varchar("badge", { length: 16 }).notNull(),
  /** `open` | `request` | `closed`. */
  type: varchar("type", { length: 10 }).notNull(),
  minLevel: int("min_level").notNull().default(0),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  uniqueIndex("uq_clans_tag").on(t.tag),
  uniqueIndex("uq_clans_name_key").on(t.nameKey),
  index("idx_clans_type").on(t.type),
]);

/** One row per member; `user_id` is the primary key, so a player is in at most one clan. */
export const clanMembers = mysqlTable("clan_members", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  clanId: char("clan_id", { length: 36 }).notNull().references(() => clans.id, { onDelete: "cascade" }),
  /** `leader` | `co_leader` | `member`. */
  role: varchar("role", { length: 12 }).notNull(),
  joinedAt: datetime("joined_at").notNull().default(now),
}, (t) => [
  index("idx_clan_members_clan").on(t.clanId, t.joinedAt),
]);

/** Pending join requests of `request` clans. `user_id` is the primary key: a player asks one clan at a time. */
export const clanJoinRequests = mysqlTable("clan_join_requests", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  clanId: char("clan_id", { length: 36 }).notNull().references(() => clans.id, { onDelete: "cascade" }),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_clan_join_requests_clan").on(t.clanId, t.createdAt),
]);

/** A member asking the clan for crew tokens of one card. */
export const clanDonationRequests = mysqlTable("clan_donation_requests", {
  id: char("id", { length: 36 }).primaryKey().notNull(),
  clanId: char("clan_id", { length: 36 }).notNull().references(() => clans.id, { onDelete: "cascade" }),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  itemId: varchar("item_id", { length: 64 }).notNull(),
  requested: int("requested").notNull(),
  received: int("received").notNull().default(0),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_clan_donation_requests_clan").on(t.clanId, t.createdAt),
  index("idx_clan_donation_requests_user").on(t.userId, t.createdAt),
]);

/** One row per donated token (limits per donor are counted from here). */
export const clanDonations = mysqlTable("clan_donations", {
  id: char("id", { length: 36 }).primaryKey().notNull(),
  requestId: char("request_id", { length: 36 }).notNull().references(() => clanDonationRequests.id, { onDelete: "cascade" }),
  donorId: char("donor_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  /** UTC day of the donation, YYYY-MM-DD (the daily cap). */
  day: char("day", { length: 10 }).notNull(),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_clan_donations_request").on(t.requestId, t.donorId),
  index("idx_clan_donations_day").on(t.donorId, t.day),
]);
