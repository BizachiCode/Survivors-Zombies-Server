// Economy: wallet balances (one row per user + currency) and the ledger of every balance change.
import { sql } from "drizzle-orm";
import { bigint, char, datetime, index, mysqlTable, primaryKey, varchar } from "drizzle-orm/mysql-core";

import { users } from "./accounts.schema.js";

const now = sql`CURRENT_TIMESTAMP`;
const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

/** A missing row means a balance of 0. Only the server's WalletLedger writes here. */
export const userCurrencies = mysqlTable("user_currencies", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  currencyId: varchar("currency_id", { length: 32 }).notNull(),
  amount: bigint("amount", { mode: "number" }).notNull().default(0),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.currencyId] }),
]);

/** Append-only history of balance changes (support, refunds, cheat investigation). */
export const currencyLedger = mysqlTable("currency_ledger", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  currencyId: varchar("currency_id", { length: 32 }).notNull(),
  delta: bigint("delta", { mode: "number" }).notNull(),
  balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
  /** Why the balance changed: STARTING_BALANCE | STAGE_REWARD | SHOP_PURCHASE | ... */
  reason: varchar("reason", { length: 32 }).notNull(),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_ledger_user").on(t.userId, t.createdAt),
]);
