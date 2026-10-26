// In-memory adapter of the wheel port. Rows are written last in a spin, so a failed payment or grant leaves no count behind.

import type { WheelDayRow, WheelRepository } from "../../src/modules/wheel/wheel.repository.js";

export class MemoryWheelRepository implements WheelRepository {
  /** Keyed by `${userId}:${day}`. */
  readonly rows = new Map<string, WheelDayRow>();

  async get(userId: string, day: string): Promise<WheelDayRow> {
    return { ...(this.rows.get(`${userId}:${day}`) ?? { spins: 0, freeSpins: 0 }) };
  }

  async lockDay(userId: string, day: string): Promise<WheelDayRow> {
    return this.get(userId, day);
  }

  async save(userId: string, day: string, row: WheelDayRow): Promise<void> {
    this.rows.set(`${userId}:${day}`, { ...row });
  }
}
