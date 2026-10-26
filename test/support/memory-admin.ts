// In-memory adapters of the admin read models / audit trail and of the settings table.

import { publicUserId } from "../../src/shared/kernel/public-id.js";
import type { AdminRepository, AuditEntry, BattleSummary, DashboardCounters, NewAuditEntry, PlayerSearch, PlayerSummary } from "../../src/modules/admin/admin.repository.js";
import type { SettingsRepository } from "../../src/modules/admin/settings.repository.js";
import type { MemoryIapRepository } from "./memory-iap.js";
import type { MemoryStore } from "./memory-repositories.js";

export class MemoryAdminRepository implements AdminRepository {
  readonly audit: AuditEntry[] = [];
  /** Friend counts to report (the friends tables are not part of MemoryStore). */
  readonly friends = new Map<string, number>();
  /** Last login times to report (MemoryStore users have none). */
  readonly lastLogin = new Map<string, Date>();
  private nextAuditId = 1;

  constructor(private readonly store: MemoryStore, private readonly iap: MemoryIapRepository, private readonly now: () => number = Date.now) {}

  async counters(todayStart: Date, weekStart: Date): Promise<DashboardCounters> {
    const purchases = new Map<string, { count: number; refunded: number }>();
    for (const row of this.iap.rows) {
      const entry = purchases.get(row.productId) ?? { count: 0, refunded: 0 };
      entry.count++;
      if (row.status === "refunded") entry.refunded++;
      purchases.set(row.productId, entry);
    }
    return {
      totalPlayers: this.store.users.size,
      activeSinceToday: [...this.lastLogin.values()].filter((at) => at >= todayStart).length,
      activeSinceWeek: [...this.lastLogin.values()].filter((at) => at >= weekStart).length,
      newSinceToday: [...this.store.users.values()].filter((user) => user.createdAt >= todayStart).length,
      purchases: [...purchases].map(([productId, value]) => ({ productId, ...value })),
    };
  }

  async search(criteria: PlayerSearch, limit: number): Promise<PlayerSummary[]> {
    const found: PlayerSummary[] = [];
    for (const user of this.store.users.values()) {
      const nickname = this.store.profiles.get(user.id)?.nickname ?? null;
      const matches = (criteria.userId && user.id === criteria.userId.toLowerCase())
        || (criteria.publicCode && publicUserId(user.id) === criteria.publicCode.toUpperCase())
        || (criteria.email && user.email === criteria.email.toLowerCase())
        || (criteria.nicknamePrefix && nickname?.toLowerCase().startsWith(criteria.nicknamePrefix.toLowerCase()));
      if (matches) found.push(this.summarize(user.id)!);
    }
    return found.slice(0, limit);
  }

  async summary(userId: string): Promise<PlayerSummary | null> {
    return this.summarize(userId);
  }

  async recentBattles(userId: string, limit: number): Promise<BattleSummary[]> {
    return [...this.store.battleResults.values()].filter((row) => row.userId === userId).slice(-limit).reverse()
      .map((row): BattleSummary => ({ id: row.id, mode: row.mode, stageId: row.stageId, outcome: row.outcome, stars: row.stars, kills: row.kills, createdAt: null }));
  }

  async friendsCount(userId: string): Promise<number> {
    return this.friends.get(userId) ?? 0;
  }

  async insertAudit(entry: NewAuditEntry): Promise<void> {
    this.audit.push({ id: this.nextAuditId++, createdAt: new Date(this.now()), ip: entry.ip, action: entry.action, target: entry.target, payload: structuredClone(entry.payload) });
  }

  async listAudit(filter: { target?: string; limit: number }): Promise<AuditEntry[]> {
    return this.audit.filter((entry) => filter.target === undefined || entry.target === filter.target).slice().reverse().slice(0, filter.limit);
  }

  private summarize(userId: string): PlayerSummary | null {
    const user = this.store.users.get(userId);
    if (!user) return null;
    const profile = this.store.profiles.get(userId);
    return {
      userId,
      publicCode: publicUserId(userId),
      nickname: profile?.nickname ?? null,
      level: profile?.level ?? null,
      email: user.email,
      isGuest: user.isGuest,
      isBanned: user.isBanned,
      banExpiresAt: user.banExpiresAt,
      createdAt: user.createdAt,
      lastLoginAt: this.lastLogin.get(userId) ?? null,
    };
  }
}

export class MemorySettingsRepository implements SettingsRepository {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}
