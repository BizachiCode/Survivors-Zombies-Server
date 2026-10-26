import { and, eq, sql } from "drizzle-orm";

import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { wheelSpins } from "../../infrastructure/database/schema/wheel.schema.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";

/** Spins a player made on one UTC day. */
export type WheelDayRow = { spins: number; freeSpins: number };

/** Persistence port of the wheel's daily spin counts. */
export interface WheelRepository {
  /** The day's counts (zeros when the player has not spun). */
  get(userId: string, day: string, session?: DbSession): Promise<WheelDayRow>;
  /** Makes sure the row exists, then locks and reads it (inside a transaction): concurrent spins of a player queue here. */
  lockDay(userId: string, day: string, session: DbSession): Promise<WheelDayRow>;
  save(userId: string, day: string, row: WheelDayRow, session: DbSession): Promise<void>;
}

export class DrizzleWheelRepository extends DrizzleRepository implements WheelRepository {
  async get(userId: string, day: string, session?: DbSession): Promise<WheelDayRow> {
    const rows = await this.db(session).select({ spins: wheelSpins.spins, freeSpins: wheelSpins.freeSpins }).from(wheelSpins)
      .where(and(eq(wheelSpins.userId, userId), eq(wheelSpins.day, day))).limit(1);
    return rows[0] ?? { spins: 0, freeSpins: 0 };
  }

  async lockDay(userId: string, day: string, session: DbSession): Promise<WheelDayRow> {
    // Insert-if-missing first, so the row exists to be locked (a lock on a missing row would not serialize two first spins).
    await this.db(session).insert(wheelSpins).values({ userId, day, spins: 0, freeSpins: 0 })
      .onDuplicateKeyUpdate({ set: { spins: sql`${wheelSpins.spins}` } });
    const rows = await this.db(session).select({ spins: wheelSpins.spins, freeSpins: wheelSpins.freeSpins }).from(wheelSpins)
      .where(and(eq(wheelSpins.userId, userId), eq(wheelSpins.day, day))).limit(1).for("update");
    return rows[0] ?? { spins: 0, freeSpins: 0 };
  }

  async save(userId: string, day: string, row: WheelDayRow, session: DbSession): Promise<void> {
    await this.db(session).update(wheelSpins).set({ spins: row.spins, freeSpins: row.freeSpins })
      .where(and(eq(wheelSpins.userId, userId), eq(wheelSpins.day, day)));
  }
}
