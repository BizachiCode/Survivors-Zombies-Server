// Friends use cases: finding players by friend code (the public id), friend requests (both ways, auto-accept when the
// other side asked first), the friend list, daily gifts and the public player card. Every rule is decided here; the
// client sends intents only. Changes that depend on a count (limits) or on the pair run under row locks on the
// profiles of the players involved (taken in id order, so two requests never deadlock), and the uniques of the
// schema stay the last line of defence against double requests and double gifts.

import { randomUUID } from "node:crypto";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import { publicUserId } from "../../shared/kernel/public-id.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { InventoryLedger, ItemAmounts } from "../collection/inventory-ledger.js";
import type { RewardBundle, RewardGranter } from "../economy/reward-granter.js";
import type { WalletDto, WalletLedger } from "../economy/wallet-ledger.js";
import { mergeRewards } from "../mail/mail.service.js";
import type { ProfileDto } from "../profile/profile.dto.js";
import { toProfileDto } from "../profile/profile.mapper.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import type { ProfileStatsReader } from "../profile/profile-stats.js";
import { FRIENDS_CONFIG, type FriendsConfig } from "./friends-config.js";
import type { FriendsRepository, PlayerRow } from "./friends.repository.js";

const DAY_MS = 86_400_000;
const CODE_PATTERN = /^[0-9A-F]{8}$/;

export type FriendDto = {
  code: string;
  nickname: string;
  avatarId: string;
  level: number;
  /** Unix seconds the friendship started. */
  since: number;
  /** I already sent this friend today's gift. */
  giftSentToday: boolean;
  /** This friend sent me a gift I have not collected. */
  giftWaiting: boolean;
  /** Last sign-in of the account (users.last_login_at), unix seconds; absent when unknown. */
  lastSeenUnix?: number;
};

export type FriendRequestDto = { code: string; nickname: string; avatarId: string; level: number; sentAtUnix: number };

export type FriendsLimitsDto = {
  maxFriends: number;
  maxIncoming: number;
  maxOutgoing: number;
  /** Gifts a player can collect per UTC day. */
  giftsPerDay: number;
  /** What one gift is worth. */
  gift: RewardBundle;
};

export type FriendsInfoDto = {
  myCode: string;
  friends: FriendDto[];
  incoming: FriendRequestDto[];
  outgoing: FriendRequestDto[];
  /** Gifts waiting for me (not collected yet, collectable today or not). */
  giftsWaiting: number;
  /** How many of them I can collect right now (the daily cap applied). */
  giftsCollectableToday: number;
  limits: FriendsLimitsDto;
};

/** `claim_gifts`: the fresh info plus what was granted and the new HUD state. */
export type FriendsClaimDto = FriendsInfoDto & {
  granted: RewardBundle;
  levelsGained: number;
  claimed: number;
  wallet: WalletDto;
  items: ItemAmounts;
  profile: ProfileDto;
};

export type PlayerRelation = "self" | "friend" | "incoming" | "outgoing" | "none";

export type PlayerCardDto = {
  code: string;
  nickname: string;
  avatarId: string;
  level: number;
  stats: { battlesWon: number; starsTotal: number; crewOwned: number; achievementsCompleted: number };
  relation: PlayerRelation;
};

/** UTC calendar day, YYYY-MM-DD. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class FriendsService {
  constructor(
    private readonly friends: FriendsRepository,
    private readonly profiles: ProfileRepository,
    private readonly rewards: RewardGranter,
    private readonly wallets: WalletLedger,
    private readonly inventory: InventoryLedger,
    private readonly stats: ProfileStatsReader,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly config: FriendsConfig = FRIENDS_CONFIG,
  ) {}

  /** Friends, pending requests (both directions), waiting gifts and the limits. */
  async info(userId: string): Promise<FriendsInfoDto> {
    const now = this.clock.now();
    const friendships = await this.friends.listFriendships(userId);
    const incoming = await this.friends.listIncoming(userId, this.requestCutoff(now));
    const outgoing = await this.friends.listOutgoing(userId, this.requestCutoff(now));
    const waiting = await this.friends.listWaitingGifts(userId, this.giftCutoff(now));
    const sentToday = await this.friends.giftReceiversOn(userId, utcDay(now));
    const collectedToday = await this.friends.countCollectedOn(userId, utcDay(now));

    const others = [...new Set([...friendships.map((f) => f.friendId), ...incoming.map((r) => r.fromUserId), ...outgoing.map((r) => r.toUserId)])];
    const players = await this.friends.players(others);
    const waitingFrom = new Set(waiting.map((gift) => gift.fromUserId));

    const friendList: FriendDto[] = [];
    for (const friendship of friendships) {
      const player = players.get(friendship.friendId);
      if (!player) continue;
      friendList.push({
        ...publicCard(player),
        since: unix(friendship.since),
        giftSentToday: sentToday.has(friendship.friendId),
        giftWaiting: waitingFrom.has(friendship.friendId),
        ...(player.lastLoginAt ? { lastSeenUnix: unix(player.lastLoginAt) } : {}),
      });
    }
    friendList.sort((a, b) => a.nickname.localeCompare(b.nickname, undefined, { sensitivity: "base" }) || a.code.localeCompare(b.code));

    const requestList = (rows: Array<{ other: string; createdAt: Date }>): FriendRequestDto[] => {
      const result: FriendRequestDto[] = [];
      for (const row of rows) {
        const player = players.get(row.other);
        if (player) result.push({ ...publicCard(player), sentAtUnix: unix(row.createdAt) });
      }
      return result;
    };

    return {
      myCode: publicUserId(userId),
      friends: friendList,
      incoming: requestList(incoming.map((r) => ({ other: r.fromUserId, createdAt: r.createdAt }))),
      outgoing: requestList(outgoing.map((r) => ({ other: r.toUserId, createdAt: r.createdAt }))),
      giftsWaiting: waiting.length,
      giftsCollectableToday: Math.min(waiting.length, Math.max(0, this.config.maxGiftsCollectedPerDay - collectedToday)),
      limits: this.limits(),
    };
  }

  /**
   * Asks the owner of `code` to be friends. When that player already asked me, the request is accepted instead and
   * both become friends at once.
   */
  async request(userId: string, code: string): Promise<FriendsInfoDto> {
    const target = await this.resolveCode(code);
    if (target === userId) throw new AppError(ErrorCode.FRIEND_SELF);
    const now = this.clock.now();
    await this.uow.transaction(async (session) => {
      await this.lockPlayers(session, [userId, target]);
      await this.friends.deleteRequestsBefore(this.requestCutoff(now), session);
      if (await this.friends.areFriends(userId, target, session)) throw new AppError(ErrorCode.FRIEND_ALREADY);

      const existing = await this.friends.getRequest(userId, target, this.requestCutoff(now), session);
      if (existing) return this.answerExisting(session, userId, target, existing.fromUserId, now);

      const max = this.config.maxFriends;
      if (await this.friends.countFriends(userId, session) >= max) throw limit(max, "friends");
      if (await this.friends.countFriends(target, session) >= max) throw limit(max, "target_friends");
      if (await this.friends.countOutgoing(userId, this.requestCutoff(now), session) >= this.config.maxOutgoing) throw limit(this.config.maxOutgoing, "outgoing");
      if (await this.friends.countIncoming(target, this.requestCutoff(now), session) >= this.config.maxIncoming) throw limit(this.config.maxIncoming, "target_incoming");

      if (!(await this.friends.insertRequest(userId, target, now, session))) {
        // Lost a race on the unique pair key: look at what won.
        const winner = await this.friends.getRequest(userId, target, this.requestCutoff(now), session);
        if (!winner) throw new AppError(ErrorCode.FRIEND_REQUEST_PENDING);
        await this.answerExisting(session, userId, target, winner.fromUserId, now);
      }
    });
    return this.info(userId);
  }

  /** Accepts the request `code` sent me. */
  async accept(userId: string, code: string): Promise<FriendsInfoDto> {
    const target = await this.resolveCode(code);
    const now = this.clock.now();
    await this.uow.transaction(async (session) => {
      await this.lockPlayers(session, [userId, target]);
      const request = await this.friends.getRequest(userId, target, this.requestCutoff(now), session);
      if (!request || request.toUserId !== userId) throw new AppError(ErrorCode.FRIEND_REQUEST_UNKNOWN);
      await this.befriend(session, userId, target, now);
    });
    return this.info(userId);
  }

  /** Declines the request `code` sent me. */
  async decline(userId: string, code: string): Promise<FriendsInfoDto> {
    const target = await this.resolveCode(code);
    await this.removeRequest(userId, target, "incoming");
    return this.info(userId);
  }

  /** Takes back my own request to `code`. */
  async cancel(userId: string, code: string): Promise<FriendsInfoDto> {
    const target = await this.resolveCode(code);
    await this.removeRequest(userId, target, "outgoing");
    return this.info(userId);
  }

  /** Ends a friendship (waiting gifts stay collectable). */
  async remove(userId: string, code: string): Promise<FriendsInfoDto> {
    const target = await this.resolveCode(code);
    await this.uow.transaction(async (session) => {
      await this.lockPlayers(session, [userId, target]);
      if (!(await this.friends.deleteFriendship(userId, target, session))) throw new AppError(ErrorCode.FRIEND_NOT_FRIENDS);
    });
    return this.info(userId);
  }

  /** Sends today's gift to a friend (once per friend per UTC day). */
  async sendGift(userId: string, code: string): Promise<FriendsInfoDto> {
    const target = await this.resolveCode(code);
    if (target === userId) throw new AppError(ErrorCode.FRIEND_SELF);
    const now = this.clock.now();
    await this.uow.transaction(async (session) => {
      if (!(await this.friends.areFriends(userId, target, session))) throw new AppError(ErrorCode.FRIEND_NOT_FRIENDS);
      const sent = await this.friends.insertGift({ id: randomUUID(), fromUserId: userId, toUserId: target, sentDay: utcDay(now), createdAt: now }, session);
      if (!sent) throw new AppError(ErrorCode.FRIEND_GIFT_ALREADY_SENT);
    });
    return this.info(userId);
  }

  /**
   * Collects the waiting gifts, oldest first, up to the daily cap (the rest stay waiting for tomorrow): one combined
   * grant through the reward granter in the same transaction that marks the gifts collected.
   */
  async claimGifts(userId: string): Promise<FriendsClaimDto> {
    const now = this.clock.now();
    const day = utcDay(now);
    const { granted, levelsGained, claimed } = await this.uow.transaction(async (session) => {
      // The profile row serializes this player's concurrent collects, so the daily cap cannot be beaten by a race.
      await this.lockPlayers(session, [userId]);
      const collectedToday = await this.friends.countCollectedOn(userId, day, session);
      const room = Math.max(0, this.config.maxGiftsCollectedPerDay - collectedToday);
      const waiting = await this.friends.listWaitingGifts(userId, this.giftCutoff(now), session, true);
      const taken = waiting.slice(0, room);
      if (taken.length === 0) throw new AppError(ErrorCode.FRIEND_NO_GIFTS);
      const total = mergeRewards(taken.map(() => this.config.gift));
      const result = await this.rewards.grant(session, userId, total, "FRIEND_GIFT");
      await this.friends.markGiftsCollected(taken.map((gift) => gift.id), now, day, session);
      return { granted: total, levelsGained: result.levelsGained, claimed: taken.length };
    });

    const profile = await this.profiles.getProfile(userId);
    if (!profile) throw new AppError(ErrorCode.UNAUTHORIZED);
    return {
      ...(await this.info(userId)),
      granted,
      levelsGained,
      claimed,
      wallet: await this.wallets.snapshot(userId),
      items: await this.inventory.snapshot(userId),
      profile: toProfileDto(profile),
    };
  }

  /** Public card of any player (yours included) and how it relates to me. */
  async player(userId: string, code: string): Promise<PlayerCardDto> {
    const target = await this.resolveCode(code);
    const player = (await this.friends.players([target])).get(target);
    if (!player) throw new AppError(ErrorCode.PLAYER_NOT_FOUND);
    const stats = await this.stats.stats(target);
    return {
      ...publicCard(player),
      stats: { battlesWon: stats.battlesWon, starsTotal: stats.starsTotal, crewOwned: stats.crewOwned, achievementsCompleted: stats.achievementsCompleted },
      relation: await this.relation(userId, target),
    };
  }

  // ------------------------------------------------------------------ internals

  /**
   * Friend code → user id. The code is the first 8 hex digits of the uuid; when two accounts share it (a collision,
   * about 1 in 4 billion per pair) nobody can be found by that code: the answer is PLAYER_NOT_FOUND for both.
   */
  private async resolveCode(code: string): Promise<string> {
    const normalized = code.trim().toUpperCase();
    if (!CODE_PATTERN.test(normalized)) throw new AppError(ErrorCode.PLAYER_NOT_FOUND);
    const ids = await this.friends.findUserIdsByPrefix(normalized.toLowerCase(), 2);
    if (ids.length !== 1) throw new AppError(ErrorCode.PLAYER_NOT_FOUND);
    return ids[0]!;
  }

  private async relation(userId: string, target: string): Promise<PlayerRelation> {
    if (userId === target) return "self";
    if (await this.friends.areFriends(userId, target)) return "friend";
    const request = await this.friends.getRequest(userId, target, this.requestCutoff(this.clock.now()));
    if (!request) return "none";
    return request.fromUserId === userId ? "outgoing" : "incoming";
  }

  /** Row-locks the profiles in id order (the lock order every friends transaction shares). */
  private async lockPlayers(session: DbSession, userIds: readonly string[]): Promise<void> {
    for (const id of [...new Set(userIds)].sort()) {
      if (!(await this.profiles.getProfile(id, session, true))) throw new AppError(ErrorCode.PLAYER_NOT_FOUND);
    }
  }

  /** There is a request between the pair: if the other side sent it, accept; if I sent it, it is still pending. */
  private async answerExisting(session: DbSession, userId: string, target: string, requestFrom: string, now: Date): Promise<void> {
    if (requestFrom === userId) throw new AppError(ErrorCode.FRIEND_REQUEST_PENDING);
    await this.befriend(session, userId, target, now);
  }

  /** Turns the pending request between the pair into a friendship (both lists must have room). */
  private async befriend(session: DbSession, userId: string, other: string, now: Date): Promise<void> {
    const max = this.config.maxFriends;
    if (await this.friends.countFriends(userId, session) >= max) throw limit(max, "friends");
    if (await this.friends.countFriends(other, session) >= max) throw limit(max, "target_friends");
    await this.friends.deleteRequest(userId, other, session);
    await this.friends.insertFriendship(userId, other, now, session);
  }

  private async removeRequest(userId: string, target: string, direction: "incoming" | "outgoing"): Promise<void> {
    const now = this.clock.now();
    await this.uow.transaction(async (session) => {
      const request = await this.friends.getRequest(userId, target, this.requestCutoff(now), session);
      const mine = direction === "outgoing" ? request?.fromUserId === userId : request?.toUserId === userId;
      if (!request || !mine) throw new AppError(ErrorCode.FRIEND_REQUEST_UNKNOWN);
      await this.friends.deleteRequest(userId, target, session);
    });
  }

  private limits(): FriendsLimitsDto {
    const { maxFriends, maxIncoming, maxOutgoing, maxGiftsCollectedPerDay, gift } = this.config;
    return { maxFriends, maxIncoming, maxOutgoing, giftsPerDay: maxGiftsCollectedPerDay, gift };
  }

  private requestCutoff(now: Date): Date {
    return new Date(now.getTime() - this.config.requestTtlDays * DAY_MS);
  }

  private giftCutoff(now: Date): Date {
    return new Date(now.getTime() - this.config.giftTtlDays * DAY_MS);
  }
}

const unix = (date: Date) => Math.floor(date.getTime() / 1000);

function publicCard(player: PlayerRow) {
  return { code: publicUserId(player.userId), nickname: player.nickname, avatarId: player.avatarId, level: player.level };
}

/** FRIEND_LIMIT with the limit and which list is full (`friends` | `target_friends` | `outgoing` | `target_incoming`). */
function limit(max: number, which: string): AppError {
  return new AppError(ErrorCode.FRIEND_LIMIT, { extra: { max, which } });
}
