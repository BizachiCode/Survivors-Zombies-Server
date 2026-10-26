// Card collection: owned cards and their levels, the team, and items (seeds, upgrade XP, materials) with their ledger.
import { sql } from "drizzle-orm";
import { bigint, char, datetime, index, int, json, mysqlTable, primaryKey, varchar } from "drizzle-orm/mysql-core";

import { users } from "./accounts.schema.js";

const now = sql`CURRENT_TIMESTAMP`;
const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

/** One row per owned card. Written only by the collection service. */
export const userCards = mysqlTable("user_cards", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  cardId: varchar("card_id", { length: 64 }).notNull(),
  level: int("level").notNull().default(1),
  /** How the card was obtained: starter | seeds | stage | purchase | level | admin. */
  source: varchar("source", { length: 16 }).notNull(),
  unlockedAt: datetime("unlocked_at").notNull().default(now),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.cardId] }),
]);

/** The player's team (ordered card ids). */
export const userDecks = mysqlTable("user_decks", {
  userId: char("user_id", { length: 36 }).primaryKey().notNull().references(() => users.id, { onDelete: "cascade" }),
  cards: json("cards").notNull(),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
});

/** Item balances (a missing row means 0). Only the server's InventoryLedger writes here. */
export const userItems = mysqlTable("user_items", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  itemId: varchar("item_id", { length: 64 }).notNull(),
  amount: bigint("amount", { mode: "number" }).notNull().default(0),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.itemId] }),
]);

/** Append-only history of item changes. */
export const itemLedger = mysqlTable("item_ledger", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement().notNull(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  itemId: varchar("item_id", { length: 64 }).notNull(),
  delta: bigint("delta", { mode: "number" }).notNull(),
  balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
  /** STAGE_REWARD | STARTING_ITEMS | CARD_UNLOCK | CARD_UPGRADE | ... */
  reason: varchar("reason", { length: 32 }).notNull(),
  createdAt: datetime("created_at").notNull().default(now),
}, (t) => [
  index("idx_item_ledger_user").on(t.userId, t.createdAt),
]);
