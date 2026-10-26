// Event towers: the highest floor each player has cleared per tower. Written only by the tower service.
import { sql } from "drizzle-orm";
import { char, datetime, int, mysqlTable, primaryKey, varchar } from "drizzle-orm/mysql-core";

import { users } from "./accounts.schema.js";

const nowOnUpdate = sql`CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;

export const towerProgress = mysqlTable("tower_progress", {
  userId: char("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  towerId: varchar("tower_id", { length: 64 }).notNull(),
  /** Floors 1..highestCleared are cleared (floors are climbed in order). */
  highestCleared: int("highest_cleared").notNull().default(0),
  updatedAt: datetime("updated_at").notNull().default(nowOnUpdate),
}, (t) => [
  primaryKey({ columns: [t.userId, t.towerId] }),
]);
