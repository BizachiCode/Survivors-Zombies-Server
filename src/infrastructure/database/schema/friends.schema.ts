// Friends: accepted friendships, pending requests and daily gifts. Written only by the friends service.
// Uniques make the invariants hold under races: one friendship per pair, one pending request per pair (either
// direction), one gift per sender, receiver and UTC day.
import { sql } from "drizzle-orm";
import { char, datetime, index, mysqlTable, primaryKey, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

import { users } from "./accounts.schema.js";

const now = sql`CURRENT_TIMESTAMP`;

/** One row per friendship; `user_a` is always the smaller user id (string order), so a pair has a single row. */
export const userFriendships = mysqlTable("user_friendships", {
  userA: char("user_a", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  userB: char("user_b", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  primaryKey({ columns: [t.userA, t.userB] }),
  index("idx_friendships_b").on(t.userB),
]);

/**
 * Pending friend requests. `pair_key` (`<smaller id>:<larger id>`) is unique, so only one request can exist between
 * two players whatever its direction: when A and B request each other at the same moment, the second insert fails and
 * the service turns the first request into a friendship.
 */
export const friendRequests = mysqlTable("friend_requests", {
  pairKey: char("pair_key", { length: 73 }).primaryKey().notNull(),
  fromUserId: char("from_user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  toUserId: char("to_user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_friend_requests_from").on(t.fromUserId),
  index("idx_friend_requests_to").on(t.toUserId),
  index("idx_friend_requests_created").on(t.createdAt),
]);

/** Daily gifts between friends. The reward itself comes from the server config when the gift is collected. */
export const friendGifts = mysqlTable("friend_gifts", {
  id: char("id", { length: 36 }).primaryKey().notNull(),
  fromUserId: char("from_user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  toUserId: char("to_user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  /** UTC day the gift was sent, YYYY-MM-DD. */
  sentDay: char("sent_day", { length: 10 }).notNull(),
  createdAt: datetime("created_at").notNull().default(now),
  claimedAt: datetime("claimed_at"),
  /** UTC day the receiver collected it (counts towards the daily collect cap), YYYY-MM-DD. */
  claimedDay: varchar("claimed_day", { length: 10 }),
}, (t) => [
  uniqueIndex("uq_friend_gifts_daily").on(t.fromUserId, t.toUserId, t.sentDay),
  index("idx_friend_gifts_inbox").on(t.toUserId, t.claimedAt, t.createdAt),
  index("idx_friend_gifts_claimed_day").on(t.toUserId, t.claimedDay),
]);
