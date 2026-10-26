// In-memory arena (players, groups, entries) with the profiles of a MemoryStore for the standings.

import type {
  ArenaEntryRow, ArenaGroupRow, ArenaPlayerRow, ArenaRepository, ArenaStandingRow,
} from "../../src/modules/arena/arena.repository.js";
import type { MemoryStore } from "./memory-repositories.js";

export class MemoryArenaRepository implements ArenaRepository {
  readonly players = new Map<string, ArenaPlayerRow>();
  readonly groups: ArenaGroupRow[] = [];
  readonly entries: ArenaEntryRow[] = [];

  constructor(private readonly store: MemoryStore) {}

  async getPlayer(userId: string): Promise<ArenaPlayerRow | null> {
    const row = this.players.get(userId);
    return row ? { ...row } : null;
  }

  async savePlayer(row: ArenaPlayerRow): Promise<void> {
    this.players.set(row.userId, { ...row });
  }

  async getEntry(seasonId: string, userId: string): Promise<ArenaEntryRow | null> {
    const row = this.entries.find((e) => e.seasonId === seasonId && e.userId === userId);
    return row ? { ...row } : null;
  }

  async insertEntry(row: ArenaEntryRow): Promise<void> {
    if (this.entries.some((e) => e.seasonId === row.seasonId && e.userId === row.userId)) throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
    this.entries.push({ ...row });
  }

  async saveEntry(row: ArenaEntryRow): Promise<void> {
    const index = this.entries.findIndex((e) => e.seasonId === row.seasonId && e.userId === row.userId);
    if (index >= 0) this.entries[index] = { ...row };
  }

  async unsettledBefore(userId: string, seasonId: string): Promise<ArenaEntryRow[]> {
    return this.entries.filter((e) => e.userId === userId && !e.settledAt && e.seasonId < seasonId)
      .sort((a, b) => a.seasonId.localeCompare(b.seasonId)).map((e) => ({ ...e }));
  }

  async lockOpenGroup(seasonId: string, leagueIndex: number, size: number): Promise<ArenaGroupRow | null> {
    const group = this.groups.find((g) => g.seasonId === seasonId && g.leagueIndex === leagueIndex && g.members < size);
    return group ? { ...group } : null;
  }

  async insertGroup(row: ArenaGroupRow): Promise<void> {
    this.groups.push({ ...row });
  }

  async setGroupMembers(groupId: string, members: number): Promise<void> {
    const group = this.groups.find((g) => g.id === groupId);
    if (group) group.members = members;
  }

  async groupEntries(groupId: string): Promise<ArenaStandingRow[]> {
    return this.entries.filter((e) => e.groupId === groupId).map((e) => {
      const profile = this.store.profiles.get(e.userId);
      return { ...e, nickname: profile?.nickname ?? "", avatarId: profile?.avatarId ?? "", level: profile?.level ?? 1 };
    });
  }
}
