import { and, asc, count, eq, gte, inArray, isNull, like, lt, or } from "drizzle-orm";

import { affectedRows, DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { userProfile, users } from "../../infrastructure/database/schema/accounts.schema.js";
import { friendGifts, friendRequests, userFriendships } from "../../infrastructure/database/schema/friends.schema.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";

/** What other players see of an account. `lastLoginAt` is the account's last sign-in (users.last_login_at), null when unknown. */
export type PlayerRow = { userId: string; nickname: string; avatarId: string; level: number; lastLoginAt: Date | null };

export type FriendshipRow = { friendId: string; since: Date };

export type RequestRow = { fromUserId: string; toUserId: string; createdAt: Date };

export type GiftRow = { id: string; fromUserId: string; toUserId: string; sentDay: string; createdAt: Date };

/** The two ids in storage order (smaller first): a pair of players has one friendship row and one request row. */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function pairKey(a: string, b: string): string {
  return orderedPair(a, b).join(":");
}

/** Persistence port of friendships, requests and gifts. Rules live in the service. */
export interface FriendsRepository {
  /** Ids of the accounts whose uuid starts with `prefix` (lower case hex), at most `limit`. */
  findUserIdsByPrefix(prefix: string, limit: number, session?: DbSession): Promise<string[]>;
  /** Public data of the given accounts (accounts without a profile are left out). */
  players(userIds: readonly string[], session?: DbSession): Promise<Map<string, PlayerRow>>;

  listFriendships(userId: string, session?: DbSession): Promise<FriendshipRow[]>;
  countFriends(userId: string, session?: DbSession): Promise<number>;
  areFriends(a: string, b: string, session?: DbSession): Promise<boolean>;
  /** False when the pair is already friends. */
  insertFriendship(a: string, b: string, at: Date, session?: DbSession): Promise<boolean>;
  /** False when the pair was not friends. */
  deleteFriendship(a: string, b: string, session?: DbSession): Promise<boolean>;

  /** Pending requests created at or after `since`. */
  listIncoming(userId: string, since: Date, session?: DbSession): Promise<RequestRow[]>;
  listOutgoing(userId: string, since: Date, session?: DbSession): Promise<RequestRow[]>;
  countIncoming(userId: string, since: Date, session?: DbSession): Promise<number>;
  countOutgoing(userId: string, since: Date, session?: DbSession): Promise<number>;
  /** The pending request between the two players, either direction (created at or after `since`). */
  getRequest(a: string, b: string, since: Date, session?: DbSession): Promise<RequestRow | null>;
  /** False when a request between the pair exists already (either direction). */
  insertRequest(fromUserId: string, toUserId: string, at: Date, session?: DbSession): Promise<boolean>;
  /** False when there was no request between the pair. */
  deleteRequest(a: string, b: string, session?: DbSession): Promise<boolean>;
  /** Removes requests created before `cutoff` (expired). */
  deleteRequestsBefore(cutoff: Date, session?: DbSession): Promise<void>;

  /** False when `from` already sent a gift to `to` on `row.sentDay`. */
  insertGift(row: GiftRow, session?: DbSession): Promise<boolean>;
  /** Uncollected gifts for the player created at or after `since`, oldest first (locked inside a transaction). */
  listWaitingGifts(userId: string, since: Date, session?: DbSession, forUpdate?: boolean): Promise<GiftRow[]>;
  /** Receivers of the gifts `fromUserId` sent on `day`. */
  giftReceiversOn(fromUserId: string, day: string, session?: DbSession): Promise<Set<string>>;
  /** Gifts the player collected on `day`. */
  countCollectedOn(userId: string, day: string, session?: DbSession): Promise<number>;
  markGiftsCollected(giftIds: readonly string[], at: Date, day: string, session?: DbSession): Promise<void>;
}

const toRequest = (row: typeof friendRequests.$inferSelect): RequestRow => ({ fromUserId: row.fromUserId, toUserId: row.toUserId, createdAt: row.createdAt });

export class DrizzleFriendsRepository extends DrizzleRepository implements FriendsRepository {
  async findUserIdsByPrefix(prefix: string, limit: number, session?: DbSession): Promise<string[]> {
    if (!/^[0-9a-f]{1,32}$/.test(prefix)) return [];
    const rows = await this.db(session).select({ id: users.id }).from(users).where(like(users.id, `${prefix}%`)).limit(limit);
    return rows.map((row) => row.id);
  }

  async players(userIds: readonly string[], session?: DbSession): Promise<Map<string, PlayerRow>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db(session)
      .select({ userId: userProfile.userId, nickname: userProfile.nickname, avatarId: userProfile.avatarId, level: userProfile.level, lastLoginAt: users.lastLoginAt })
      .from(userProfile).innerJoin(users, eq(users.id, userProfile.userId))
      .where(inArray(userProfile.userId, [...userIds]));
    return new Map(rows.map((row) => [row.userId, row]));
  }

  async listFriendships(userId: string, session?: DbSession): Promise<FriendshipRow[]> {
    const rows = await this.db(session).select().from(userFriendships)
      .where(or(eq(userFriendships.userA, userId), eq(userFriendships.userB, userId)))
      .orderBy(asc(userFriendships.createdAt)).limit(1000);
    return rows.map((row) => ({ friendId: row.userA === userId ? row.userB : row.userA, since: row.createdAt }));
  }

  async countFriends(userId: string, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ n: count() }).from(userFriendships)
      .where(or(eq(userFriendships.userA, userId), eq(userFriendships.userB, userId)));
    return Number(row?.n ?? 0);
  }

  async areFriends(a: string, b: string, session?: DbSession): Promise<boolean> {
    const [userA, userB] = orderedPair(a, b);
    const rows = await this.db(session).select({ a: userFriendships.userA }).from(userFriendships)
      .where(and(eq(userFriendships.userA, userA), eq(userFriendships.userB, userB))).limit(1);
    return rows.length > 0;
  }

  async insertFriendship(a: string, b: string, at: Date, session?: DbSession): Promise<boolean> {
    const [userA, userB] = orderedPair(a, b);
    try {
      await this.db(session).insert(userFriendships).values({ userA, userB, createdAt: at });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async deleteFriendship(a: string, b: string, session?: DbSession): Promise<boolean> {
    const [userA, userB] = orderedPair(a, b);
    const result = await this.db(session).delete(userFriendships).where(and(eq(userFriendships.userA, userA), eq(userFriendships.userB, userB)));
    return affectedRows(result) > 0;
  }

  async listIncoming(userId: string, since: Date, session?: DbSession): Promise<RequestRow[]> {
    const rows = await this.db(session).select().from(friendRequests)
      .where(and(eq(friendRequests.toUserId, userId), gte(friendRequests.createdAt, since))).orderBy(asc(friendRequests.createdAt)).limit(500);
    return rows.map(toRequest);
  }

  async listOutgoing(userId: string, since: Date, session?: DbSession): Promise<RequestRow[]> {
    const rows = await this.db(session).select().from(friendRequests)
      .where(and(eq(friendRequests.fromUserId, userId), gte(friendRequests.createdAt, since))).orderBy(asc(friendRequests.createdAt)).limit(500);
    return rows.map(toRequest);
  }

  async countIncoming(userId: string, since: Date, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ n: count() }).from(friendRequests)
      .where(and(eq(friendRequests.toUserId, userId), gte(friendRequests.createdAt, since)));
    return Number(row?.n ?? 0);
  }

  async countOutgoing(userId: string, since: Date, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ n: count() }).from(friendRequests)
      .where(and(eq(friendRequests.fromUserId, userId), gte(friendRequests.createdAt, since)));
    return Number(row?.n ?? 0);
  }

  async getRequest(a: string, b: string, since: Date, session?: DbSession): Promise<RequestRow | null> {
    const rows = await this.db(session).select().from(friendRequests)
      .where(and(eq(friendRequests.pairKey, pairKey(a, b)), gte(friendRequests.createdAt, since))).limit(1);
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async insertRequest(fromUserId: string, toUserId: string, at: Date, session?: DbSession): Promise<boolean> {
    try {
      await this.db(session).insert(friendRequests).values({ pairKey: pairKey(fromUserId, toUserId), fromUserId, toUserId, createdAt: at });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async deleteRequest(a: string, b: string, session?: DbSession): Promise<boolean> {
    const result = await this.db(session).delete(friendRequests).where(eq(friendRequests.pairKey, pairKey(a, b)));
    return affectedRows(result) > 0;
  }

  async deleteRequestsBefore(cutoff: Date, session?: DbSession): Promise<void> {
    await this.db(session).delete(friendRequests).where(lt(friendRequests.createdAt, cutoff));
  }

  async insertGift(row: GiftRow, session?: DbSession): Promise<boolean> {
    try {
      await this.db(session).insert(friendGifts).values({ id: row.id, fromUserId: row.fromUserId, toUserId: row.toUserId, sentDay: row.sentDay, createdAt: row.createdAt });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async listWaitingGifts(userId: string, since: Date, session?: DbSession, forUpdate = false): Promise<GiftRow[]> {
    const query = this.db(session).select({
      id: friendGifts.id, fromUserId: friendGifts.fromUserId, toUserId: friendGifts.toUserId, sentDay: friendGifts.sentDay, createdAt: friendGifts.createdAt,
    }).from(friendGifts)
      .where(and(eq(friendGifts.toUserId, userId), isNull(friendGifts.claimedAt), gte(friendGifts.createdAt, since)))
      .orderBy(asc(friendGifts.createdAt), asc(friendGifts.id)).limit(1000);
    return forUpdate ? query.for("update") : query;
  }

  async giftReceiversOn(fromUserId: string, day: string, session?: DbSession): Promise<Set<string>> {
    const rows = await this.db(session).select({ to: friendGifts.toUserId }).from(friendGifts)
      .where(and(eq(friendGifts.fromUserId, fromUserId), eq(friendGifts.sentDay, day)));
    return new Set(rows.map((row) => row.to));
  }

  async countCollectedOn(userId: string, day: string, session?: DbSession): Promise<number> {
    const [row] = await this.db(session).select({ n: count() }).from(friendGifts)
      .where(and(eq(friendGifts.toUserId, userId), eq(friendGifts.claimedDay, day)));
    return Number(row?.n ?? 0);
  }

  async markGiftsCollected(giftIds: readonly string[], at: Date, day: string, session?: DbSession): Promise<void> {
    if (giftIds.length === 0) return;
    await this.db(session).update(friendGifts).set({ claimedAt: at, claimedDay: day }).where(inArray(friendGifts.id, [...giftIds]));
  }
}
