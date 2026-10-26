// Lucky wheel: spins per player and UTC day (free-spin and daily-limit accounting). Written only by the wheel service.
import { sql } from "drizzle-orm";
import { char, datetime, int, mysqlTable, primaryKey } from "drizzle-orm/mysql-core";

import { users } from "./accounts.schema.js";

const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

export const wheelSpins = mysqlTable("wheel_spins", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  /** UTC day, YYYY-MM-DD. */
  day: char("day", { length: 10 }).notNull(),
  /** Every spin of the day (free + paid): the daily limit counts this. */
  spins: int("spins").notNull().default(0),
  /** Spins of the day that used the free allowance. */
  freeSpins: int("free_spins").notNull().default(0),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.day] }),
]);
