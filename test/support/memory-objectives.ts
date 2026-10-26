// In-memory objectives repository (unit and protocol tests). Transactions are not rolled back here: services check
// before writing, like the Drizzle implementation under a real transaction.

import type { DailyRewardRow, ObjectiveProgressRow, ObjectivesRepository } from "../../src/modules/objectives/objectives.repository.js";

export class MemoryObjectivesRepository implements ObjectivesRepository {
  /** Keyed by `${userId}|${objectiveId}|${period}`. */
  readonly progress = new Map<string, ObjectiveProgressRow>();
  readonly daily = new Map<string, DailyRewardRow>();

  async listProgress(userId: string, periods: readonly string[]): Promise<ObjectiveProgressRow[]> {
    return [...this.progress.entries()]
      .filter(([key, row]) => key.startsWith(`${userId}|`) && periods.includes(row.period))
      .map(([, row]) => ({ ...row }));
  }

  async increment(userId: string, entries: readonly { objectiveId: string; period: string; delta: number }[]): Promise<void> {
    for (const entry of entries) {
      const key = `${userId}|${entry.objectiveId}|${entry.period}`;
      const row = this.progress.get(key) ?? { objectiveId: entry.objectiveId, period: entry.period, progress: 0, claimedAt: null };
      row.progress += entry.delta;
      this.progress.set(key, row);
    }
  }

  async lockProgress(userId: string, objectiveId: string, period: string): Promise<ObjectiveProgressRow | null> {
    const row = this.progress.get(`${userId}|${objectiveId}|${period}`);
    return row ? { ...row } : null;
  }

  async markClaimed(userId: string, objectiveId: string, period: string, at: Date): Promise<void> {
    const row = this.progress.get(`${userId}|${objectiveId}|${period}`);
    if (row) row.claimedAt = at;
  }

  async getDaily(userId: string): Promise<DailyRewardRow | null> {
    const row = this.daily.get(userId);
    return row ? { ...row } : null;
  }

  async saveDaily(row: DailyRewardRow): Promise<void> {
    this.daily.set(row.userId, { ...row });
  }
}
