// In-memory adapter of the tower port.

import type { TowerRepository } from "../../src/modules/tower/tower.repository.js";

export class MemoryTowerRepository implements TowerRepository {
  /** Keyed by `${userId}:${towerId}`. */
  readonly rows = new Map<string, number>();

  async highestCleared(userId: string, towerIds: readonly string[]): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    for (const towerId of towerIds) {
      const value = this.rows.get(`${userId}:${towerId}`);
      if (value !== undefined) found.set(towerId, value);
    }
    return found;
  }

  async lockProgress(userId: string, towerId: string): Promise<number> {
    return this.rows.get(`${userId}:${towerId}`) ?? 0;
  }

  async save(userId: string, towerId: string, highestCleared: number): Promise<void> {
    this.rows.set(`${userId}:${towerId}`, highestCleared);
  }
}
