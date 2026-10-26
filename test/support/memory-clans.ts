// In-memory adapter of the clans port. Players, profiles and campaign stars come from the MemoryStore; `lastLogin` is set
// by tests. Like the other social memory repositories it is kept apart from MemoryStore: the service writes here after
// the ledger writes of a transaction, so a failed ledger leaves nothing behind.

import type {
  ClanMemberRow, ClanPatch, ClanPlayerRow, ClanRankRow, ClanRow, ClansRepository, ClanStanding, DonationRequestRow, DonationRow, JoinRequestRow,
} from "../../src/modules/clans/clans.repository.js";
import type { ClanRole } from "../../src/modules/clans/clans-config.js";
import type { MemoryStore } from "./memory-repositories.js";

export class MemoryClansRepository implements ClansRepository {
  readonly clans = new Map<string, ClanRow>();
  readonly members = new Map<string, ClanMemberRow>();
  readonly joinRequests = new Map<string, JoinRequestRow>();
  readonly donationRequests = new Map<string, DonationRequestRow>();
  readonly donations: DonationRow[] = [];
  /** last_login_at per user (set by tests). */
  readonly lastLogin = new Map<string, Date>();

  constructor(private readonly store: MemoryStore) {}

  async insertClan(row: ClanRow): Promise<boolean> {
    for (const clan of this.clans.values()) {
      if (clan.tag === row.tag || clan.name.toLowerCase() === row.name.toLowerCase()) return false;
    }
    this.clans.set(row.id, { ...row });
    return true;
  }

  async getClan(id: string): Promise<ClanRow | null> {
    const row = this.clans.get(id);
    return row ? { ...row } : null;
  }

  async getClans(ids: readonly string[]): Promise<ClanRow[]> {
    return ids.flatMap((id) => (this.clans.has(id) ? [{ ...this.clans.get(id)! }] : []));
  }

  async getClanByTag(tag: string): Promise<ClanRow | null> {
    for (const clan of this.clans.values()) if (clan.tag === tag) return { ...clan };
    return null;
  }

  async nameExists(nameKey: string): Promise<boolean> {
    return [...this.clans.values()].some((clan) => clan.name.toLowerCase() === nameKey);
  }

  async updateClan(id: string, patch: ClanPatch): Promise<void> {
    Object.assign(this.clans.get(id)!, patch);
  }

  async deleteClan(id: string): Promise<void> {
    this.clans.delete(id);
    for (const [userId, member] of this.members) if (member.clanId === id) this.members.delete(userId);
    for (const [userId, request] of this.joinRequests) if (request.clanId === id) this.joinRequests.delete(userId);
    for (const [requestId, request] of this.donationRequests) {
      if (request.clanId !== id) continue;
      this.donationRequests.delete(requestId);
      for (let i = this.donations.length - 1; i >= 0; i--) if (this.donations[i]!.requestId === requestId) this.donations.splice(i, 1);
    }
  }

  async searchByName(prefixKey: string, limit: number): Promise<ClanRow[]> {
    return [...this.clans.values()].filter((clan) => clan.type !== "closed" && clan.name.toLowerCase().startsWith(prefixKey))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).slice(0, limit).map((clan) => ({ ...clan }));
  }

  async listJoinable(level: number, limit: number): Promise<ClanRow[]> {
    return [...this.clans.values()].filter((clan) => clan.type !== "closed" && clan.minLevel <= level)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)).slice(0, limit).map((clan) => ({ ...clan }));
  }

  async memberCounts(clanIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const member of this.members.values()) if (clanIds.includes(member.clanId)) counts.set(member.clanId, (counts.get(member.clanId) ?? 0) + 1);
    return counts;
  }

  /** Stars of a player (sum of `best_stars`). */
  starsOf(userId: string): number {
    return [...this.store.stageProgress.values()].filter((row) => row.userId === userId).reduce((sum, row) => sum + row.bestStars, 0);
  }

  async scores(clanIds: readonly string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const member of this.members.values()) {
      if (clanIds.includes(member.clanId)) result.set(member.clanId, (result.get(member.clanId) ?? 0) + this.starsOf(member.userId));
    }
    return result;
  }

  async stars(userIds: readonly string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const userId of userIds) {
      const stars = this.starsOf(userId);
      if (stars > 0) result.set(userId, stars);
    }
    return result;
  }

  private ranked(): ClanRankRow[] {
    const all = [...this.clans.values()].map((clan) => {
      const members = [...this.members.values()].filter((member) => member.clanId === clan.id);
      return { clan, members: members.length, score: members.reduce((sum, member) => sum + this.starsOf(member.userId), 0) };
    }).filter((entry) => entry.members > 0);
    all.sort((a, b) => b.score - a.score || b.members - a.members || a.clan.createdAt.getTime() - b.clan.createdAt.getTime() || a.clan.id.localeCompare(b.clan.id));
    return all.map((entry) => ({ clanId: entry.clan.id, score: entry.score, members: entry.members }));
  }

  /** Number of `topClans` queries served (tests check the cache with it). */
  topQueries = 0;

  async topClans(limit: number): Promise<ClanRankRow[]> {
    this.topQueries++;
    return this.ranked().slice(0, limit);
  }

  async standing(clanId: string): Promise<ClanStanding | null> {
    const all = this.ranked();
    const own = all.find((row) => row.clanId === clanId);
    if (!own) return null;
    return { score: own.score, better: all.filter((row) => row.score > own.score).length };
  }

  async getMember(userId: string): Promise<ClanMemberRow | null> {
    const row = this.members.get(userId);
    return row ? { ...row } : null;
  }

  async listMembers(clanId: string): Promise<ClanMemberRow[]> {
    return [...this.members.values()].filter((member) => member.clanId === clanId)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.userId.localeCompare(b.userId)).map((member) => ({ ...member }));
  }

  async insertMember(row: ClanMemberRow): Promise<boolean> {
    if (this.members.has(row.userId)) return false;
    this.members.set(row.userId, { ...row });
    return true;
  }

  async deleteMember(userId: string, clanId: string): Promise<boolean> {
    const row = this.members.get(userId);
    if (!row || row.clanId !== clanId) return false;
    return this.members.delete(userId);
  }

  async setRole(userId: string, role: ClanRole): Promise<void> {
    this.members.get(userId)!.role = role;
  }

  async players(userIds: readonly string[]): Promise<Map<string, ClanPlayerRow>> {
    const result = new Map<string, ClanPlayerRow>();
    for (const userId of userIds) {
      const profile = this.store.profiles.get(userId);
      if (profile) result.set(userId, { userId, nickname: profile.nickname, avatarId: profile.avatarId, level: profile.level, lastLoginAt: this.lastLogin.get(userId) ?? null });
    }
    return result;
  }

  async insertJoinRequest(row: JoinRequestRow): Promise<boolean> {
    if (this.joinRequests.has(row.userId)) return false;
    this.joinRequests.set(row.userId, { ...row });
    return true;
  }

  async getJoinRequest(userId: string, since: Date): Promise<JoinRequestRow | null> {
    const row = this.joinRequests.get(userId);
    return row && row.createdAt >= since ? { ...row } : null;
  }

  async listJoinRequests(clanId: string, since: Date): Promise<JoinRequestRow[]> {
    return [...this.joinRequests.values()].filter((row) => row.clanId === clanId && row.createdAt >= since)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.userId.localeCompare(b.userId)).map((row) => ({ ...row }));
  }

  async deleteJoinRequest(userId: string): Promise<boolean> {
    return this.joinRequests.delete(userId);
  }

  async insertDonationRequest(row: DonationRequestRow): Promise<void> {
    this.donationRequests.set(row.id, { ...row });
  }

  async latestDonationRequest(userId: string): Promise<DonationRequestRow | null> {
    const rows = [...this.donationRequests.values()].filter((row) => row.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return rows[0] ? { ...rows[0] } : null;
  }

  async getDonationRequest(id: string): Promise<DonationRequestRow | null> {
    const row = this.donationRequests.get(id);
    return row ? { ...row } : null;
  }

  async listDonationRequests(clanId: string, since: Date): Promise<DonationRequestRow[]> {
    return [...this.donationRequests.values()].filter((row) => row.clanId === clanId && row.createdAt >= since)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).map((row) => ({ ...row }));
  }

  async addReceived(id: string): Promise<void> {
    this.donationRequests.get(id)!.received++;
  }

  async insertDonation(row: DonationRow): Promise<void> {
    this.donations.push({ ...row });
  }

  async donationsByDonor(requestIds: readonly string[], donorId: string): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    for (const donation of this.donations) {
      if (donation.donorId === donorId && requestIds.includes(donation.requestId)) result.set(donation.requestId, (result.get(donation.requestId) ?? 0) + 1);
    }
    return result;
  }

  async countDonationsOn(donorId: string, day: string): Promise<number> {
    return this.donations.filter((donation) => donation.donorId === donorId && donation.day === day).length;
  }
}
