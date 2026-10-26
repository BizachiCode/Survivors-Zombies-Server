// Real-money purchases: one row per verified store transaction. The unique (store, transaction_key) makes a receipt
// grant once, whoever sends it and however many times. Written only by the iap service.
import { sql } from "drizzle-orm";
import { char, datetime, index, int, json, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

import { users } from "./accounts.schema.js";

export const iapPurchases = mysqlTable("iap_purchases", {
  id: char("id", { length: 36 }).primaryKey(),
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  /** google | apple | fake */
  store: varchar("store", { length: 16 }).notNull(),
  /** sha256 hex of the store transaction id (Google purchase tokens are too long for a unique index). */
  transactionKey: char("transaction_key", { length: 64 }).notNull(),
  transactionId: varchar("transaction_id", { length: 512 }).notNull(),
  orderId: varchar("order_id", { length: 128 }).notNull().default(""),
  productId: varchar("product_id", { length: 64 }).notNull(),
  storeProductId: varchar("store_product_id", { length: 150 }).notNull().default(""),
  /** production | sandbox | fake */
  environment: varchar("environment", { length: 16 }).notNull(),
  quantity: int("quantity").notNull().default(1),
  /** What the purchase credited (currencies, items, exp), for support and refunds. */
  granted: json("granted").notNull(),
  purchasedAt: datetime("purchased_at").notNull(),
  /** granted | refunded (the store took the money back and the grants were revoked, see IapRefundService). */
  status: varchar("status", { length: 16 }).notNull().default("granted"),
  refundedAt: datetime("refunded_at"),
  /** Why: apple_refund | apple_revoke | google_voided... | admin:<text>. */
  refundReason: varchar("refund_reason", { length: 255 }),
  /** What could not be taken back because the player had already spent it: `{ currencies, items, exp }`. */
  refundShortfall: json("refund_shortfall"),
  createdAt: datetime("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  uniqueIndex("iap_purchases_transaction").on(t.store, t.transactionKey),
  index("iap_purchases_user_product").on(t.userId, t.productId),
  index("iap_purchases_created").on(t.createdAt),
]);
