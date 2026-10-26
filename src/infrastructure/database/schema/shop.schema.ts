// Shop: purchases per offer and UTC day (daily limits). Written only by the shop service.
import { sql } from "drizzle-orm";
import { char, datetime, int, mysqlTable, primaryKey, varchar } from "drizzle-orm/mysql-core";

import { users } from "./accounts.schema.js";

const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

export const shopPurchases = mysqlTable("shop_purchases", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  offerId: varchar("offer_id", { length: 64 }).notNull(),
  /** UTC day, YYYY-MM-DD. */
  day: char("day", { length: 10 }).notNull(),
  count: int("count").notNull().default(0),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.offerId, t.day] }),
]);
