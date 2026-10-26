// In-memory adapter of the friends port. Players come from the MemoryStore (users + profiles); `lastLogin` is set by
// tests (the memory auth repository does not track last_login_at). Like the memory mail repository it is kept apart from
// MemoryStore: the service writes here after the ledger writes of a transaction, so a failed grant leaves nothing behind.

import {
  orderedPair, pairKey, type FriendshipRow, type FriendsRepository, type GiftRow, type PlayerRow, type RequestRow,
} from "../../src/modules/friends/friends.repository.js";
import type { MemoryStore } from "./memory-repositories.js";

type StoredGift = GiftRow & { claimedAt: Date | null; claimedDay: string | null };

export class MemoryFriendsRepository implements FriendsRepository {
  readonly friendships = new Map<string, { a: string; b: string; createdAt: Date }>();
  readonly requests = new Map<string, RequestRow>();
  readonly gifts: StoredGift[] = [];
  /** last_login_at per user (set by tests). */
  readonly lastLogin = new Map<string, Date>();

  constructor(private readonly store: MemoryStore) {}

  async findUserIdsByPrefix(prefix: string, limit: number): Promise<string[]> {
    return [...this.store.users.keys()].filter((id) => id.startsWith(prefix)).slice(0, limit);
  }

  async players(userIds: readonly string[]): Promise<Map<string, PlayerRow>> {
    const result = new Map<string, PlayerRow>();
    for (const userId of userIds) {
      const profile = this.store.profiles.get(userId);
      if (profile) result.set(userId, { userId, nickname: profile.nickname, avatarId: profile.avatarId, level: profile.level, lastLoginAt: this.lastLogin.get(userId) ?? null });
    }
    return result;
  }

  async listFriendships(userId: string): Promise<FriendshipRow[]> {
    return [...this.friendships.values()].filter((f) => f.a === userId || f.b === userId)
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())
      .map((f) => ({ friendId: f.a === userId ? f.b : f.a, since: f.createdAt }));
  }

  async countFriends(userId: string): Promise<number> {
    return (await this.listFriendships(userId)).length;
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    return this.friendships.has(pairKey(a, b));
  }

  async insertFriendship(a: string, b: string, at: Date): Promise<boolean> {
    const key = pairKey(a, b);
    if (this.friendships.has(key)) return false;
    const [x, y] = orderedPair(a, b);
    this.friendships.set(key, { a: x, b: y, createdAt: at });
    return true;
  }

  async deleteFriendship(a: string, b: string): Promise<boolean> {
    return this.friendships.delete(pairKey(a, b));
  }

  async listIncoming(userId: string, since: Date): Promise<RequestRow[]> {
    return this.sortedRequests((r) => r.toUserId === userId && r.createdAt >= since);
  }

  async listOutgoing(userId: string, since: Date): Promise<RequestRow[]> {
    return this.sortedRequests((r) => r.fromUserId === userId && r.createdAt >= since);
  }

  async countIncoming(userId: string, since: Date): Promise<number> {
    return (await this.listIncoming(userId, since)).length;
  }

  async countOutgoing(userId: string, since: Date): Promise<number> {
    return (await this.listOutgoing(userId, since)).length;
  }

  async getRequest(a: string, b: string, since: Date): Promise<RequestRow | null> {
    const row = this.requests.get(pairKey(a, b));
    return row && row.createdAt >= since ? { ...row } : null;
  }

  async insertRequest(fromUserId: string, toUserId: string, at: Date): Promise<boolean> {
    const key = pairKey(fromUserId, toUserId);
    if (this.requests.has(key)) return false;
    this.requests.set(key, { fromUserId, toUserId, createdAt: at });
    return true;
  }

  async deleteRequest(a: string, b: string): Promise<boolean> {
    return this.requests.delete(pairKey(a, b));
  }

  async deleteRequestsBefore(cutoff: Date): Promise<void> {
    for (const [key, row] of this.requests) if (row.createdAt < cutoff) this.requests.delete(key);
  }

  async insertGift(row: GiftRow): Promise<boolean> {
    if (this.gifts.some((g) => g.fromUserId === row.fromUserId && g.toUserId === row.toUserId && g.sentDay === row.sentDay)) return false;
    this.gifts.push({ ...row, claimedAt: null, claimedDay: null });
    return true;
  }

  async listWaitingGifts(userId: string, since: Date): Promise<GiftRow[]> {
    return this.gifts.filter((g) => g.toUserId === userId && !g.claimedAt && g.createdAt >= since)
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.id.localeCompare(y.id))
      .map((g) => ({ id: g.id, fromUserId: g.fromUserId, toUserId: g.toUserId, sentDay: g.sentDay, createdAt: g.createdAt }));
  }

  async giftReceiversOn(fromUserId: string, day: string): Promise<Set<string>> {
    return new Set(this.gifts.filter((g) => g.fromUserId === fromUserId && g.sentDay === day).map((g) => g.toUserId));
  }

  async countCollectedOn(userId: string, day: string): Promise<number> {
    return this.gifts.filter((g) => g.toUserId === userId && g.claimedDay === day).length;
  }

  async markGiftsCollected(giftIds: readonly string[], at: Date, day: string): Promise<void> {
    for (const gift of this.gifts) {
      if (giftIds.includes(gift.id)) Object.assign(gift, { claimedAt: at, claimedDay: day });
    }
  }

  private sortedRequests(filter: (row: RequestRow) => boolean): RequestRow[] {
    return [...this.requests.values()].filter(filter).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).map((r) => ({ ...r }));
  }
}
