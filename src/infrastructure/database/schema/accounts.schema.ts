// Accounts: users, guest device bindings, refresh tokens, profiles and the audit trail.
import { sql } from "drizzle-orm";
import { bigint, boolean, char, datetime, index, int, json, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

import { DEFAULT_AVATAR_ID } from "../../../config/game-config.js";

const now = sql`CURRENT_TIMESTAMP`;
const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

export const users = mysqlTable("users", {
  id: char("id", { length: 36 }).primaryKey().notNull(),
  /** null for guests; set (lower case) by `account/link_email`. */
  email: varchar("email", { length: 255 }),
  /** null for guests (they sign in with their device). */
  passwordHash: varchar("password_hash", { length: 255 }),
  isGuest: boolean("is_guest").notNull().default(true),
  failedLogins: int("failed_logins").notNull().default(0),
  lockedUntil: datetime("locked_until"),
  isBanned: boolean("is_banned").notNull().default(false),
  banReason: varchar("ban_reason", { length: 255 }),
  banExpiresAt: datetime("ban_expires_at"),
  createdAt: datetime("created_at").notNull().default(now),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
  lastLoginAt: datetime("last_login_at"),
  passwordChangedAt: datetime("password_changed_at"),
}, (t) => [
  uniqueIndex("uq_users_email").on(t.email),
  index("idx_users_last_login").on(t.lastLoginAt),
  index("idx_users_ban").on(t.isBanned, t.banExpiresAt),
]);

/**
 * Guest account of a device: one row per device, keyed by a peppered hash of the device id (the raw id is never
 * stored). Linking an email removes the binding, so a device id alone can never open a protected account.
 */
export const userDevices = mysqlTable("user_devices", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceHash: char("device_hash", { length: 64 }).notNull(),
  platform: varchar("platform", { length: 32 }),
  createdAt: datetime("created_at").notNull().default(now),
  lastSeenAt: datetime("last_seen_at").notNull().default(now),
}, (t) => [
  uniqueIndex("uq_user_devices_hash").on(t.deviceHash),
  index("idx_user_devices_user").on(t.userId),
]);

export const userRefreshTokens = mysqlTable("user_refresh_tokens", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceKey: varchar("device_key", { length: 64 }).notNull(),
  tokenHash: char("token_hash", { length: 64 }).notNull(),
  issuedAt: datetime("issued_at").notNull().default(now),
  lastUsedAt: datetime("last_used_at").notNull().default(now),
  expiresAt: datetime("expires_at").notNull(),
  isRevoked: boolean("is_revoked").notNull().default(false),
  ip: varchar("ip", { length: 45 }),
  userAgent: varchar("user_agent", { length: 255 }),
}, (t) => [
  uniqueIndex("uq_urt_user_device").on(t.userId, t.deviceKey),
  index("idx_urt_expiry").on(t.expiresAt),
]);

export const userProfile = mysqlTable("user_profile", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  nickname: varchar("nickname", { length: 24 }).notNull(),
  avatarId: varchar("avatar_id", { length: 64 }).notNull().default(DEFAULT_AVATAR_ID),
  level: int("level").notNull().default(1),
  exp: bigint("exp", { mode: "number" }).notNull().default(0),
  createdAt: datetime("created_at").notNull().default(now),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  index("idx_profile_level").on(t.level, t.exp),
]);

export const auditEvents = mysqlTable("audit_events", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  userId: char("user_id", { length: 36 }).references(() => users.id, { onDelete: "set null" }),
  /** GUEST_CREATED | DEVICE_LOGIN | LOGIN | REFRESH | LOGOUT | LINK_EMAIL | PASSWORD_CHANGE | NICKNAME_CHANGE | ... */
  kind: varchar("kind", { length: 32 }).notNull(),
  meta: json("meta"),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_audit_user").on(t.userId),
  index("idx_audit_created").on(t.createdAt),
]);
