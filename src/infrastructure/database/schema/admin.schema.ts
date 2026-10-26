// Operations: the audit trail of the admin panel and a small key/value table for server-side bookkeeping (poll cursors).
import { sql } from "drizzle-orm";
import { bigint, datetime, index, json, mysqlTable, varchar } from "drizzle-orm/mysql-core";

const now = sql`CURRENT_TIMESTAMP`;
const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

/** Every mutating action done through the admin API. Append-only; written only by the admin service. */
export const adminAudit = mysqlTable("admin_audit", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  createdAt: datetime("created_at").notNull().default(now),
  ip: varchar("ip", { length: 45 }).notNull().default(""),
  /** player.grant | player.remove | player.mail | player.ban | player.unban | maintenance | news.create | iap.refund ... */
  action: varchar("action", { length: 48 }).notNull(),
  /** The user id, the content id (`news:<id>`), or "" for server-wide actions. */
  target: varchar("target", { length: 128 }).notNull().default(""),
  /** What was asked and what happened. Never contains the admin token. */
  payload: json("payload").notNull(),
}, (t) => [
  index("idx_admin_audit_target").on(t.target, t.createdAt),
  index("idx_admin_audit_created").on(t.createdAt),
]);

/** Server bookkeeping that must survive restarts (e.g. the last voided-purchases time already processed). */
export const serverSettings = mysqlTable("server_settings", {
  key: varchar("key", { length: 64 }).primaryKey().notNull(),
  value: varchar("value", { length: 512 }).notNull(),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
});
