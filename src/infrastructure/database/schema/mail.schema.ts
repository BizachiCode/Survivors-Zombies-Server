// Mail: one row per message in a player's inbox (broadcasts are copied here once per player). Written only by the mail service.
import { sql } from "drizzle-orm";
import { char, datetime, index, json, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

import { users } from "./accounts.schema.js";

const now = sql`CURRENT_TIMESTAMP`;

export const userMail = mysqlTable("user_mail", {
  id: char("id", { length: 36 }).primaryKey().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Content id of the broadcast this row was delivered from (null = sent to this player only). */
  broadcastId: varchar("broadcast_id", { length: 64 }),
  sender: varchar("sender", { length: 64 }).notNull(),
  /** Localized text: a string or `{ en, pt?, es? }`. */
  title: json("title").notNull(),
  body: json("body").notNull(),
  /** RewardBundle: `{ currencies, items, exp }`. */
  attachments: json("attachments").notNull(),
  createdAt: datetime("created_at").notNull().default(now),
  expiresAt: datetime("expires_at"),
  readAt: datetime("read_at"),
  claimedAt: datetime("claimed_at"),
  /** Soft delete: the row stays so a broadcast is never delivered twice. */
  deletedAt: datetime("deleted_at"),
}, (t) => [
  uniqueIndex("uq_user_mail_broadcast").on(t.userId, t.broadcastId),
  index("idx_user_mail_user").on(t.userId, t.createdAt),
]);
