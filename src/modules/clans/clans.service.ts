// Clans use cases: create / search / join (open, by request, closed), roles, kicking, leadership transfer, the ranking
// of clans and token donations. Every rule is decided here; the client sends intents only (never amounts, never a
// role). Changes that depend on the member count or on the clan's settings run under a row lock on the clan, and the
// uniques of the schema (one clan per player, tag, name) stay the last line of defence under races.

import { randomInt, randomUUID } from "node:crypto";

import { NICKNAME_RULES } from "../../config/game-config.js";
import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import { publicUserId } from "../../shared/kernel/public-id.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { BattleCatalog } from "../battle/content/battle-content.js";
import type { CollectionRepository } from "../collection/collection.repository.js";
import type { InventoryLedger, ItemAmounts } from "../collection/inventory-ledger.js";
import type { WalletDto, WalletLedger } from "../economy/wallet-ledger.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import {
  CLAN_BADGES, CLAN_TAG_ALPHABET, CLAN_TAG_LENGTH, CLANS_CONFIG, type ClanRole, type ClansConfig, type ClanType,
} from "./clans-config.js";
import { clanChannel } from "./clans-config.js";
import type {
  ClanMemberRow, ClanPlayerRow, ClanRankRow, ClanRow, ClansRepository, ClanStanding, DonationRequestRow,
} from "./clans.repository.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NAME_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
const DESCRIPTION_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;
const ROLE_ORDER: Record<ClanRole, number> = { leader: 0, co_leader: 1, member: 2 };

/** What the clans service needs from the chat: system lines in the clan channel and removing people from it. */
export interface ClanChatPort {
  /** A system line in the clan's chat. */
  /** A system line: `text` in English, `key` + `args` for clients that translate it (chat_<key>). */
  announce(clanId: string, text: string, key?: string, args?: string[]): void;
  /** Takes `userId` out of the clan's chat (kicked or left). */
  evict(clanId: string, userId: string): void;
  /** The clan is gone: closes its chat. */
  close(clanId: string): void;
}

export const silentClanChat: ClanChatPort = { announce: () => undefined, evict: () => undefined, close: () => undefined };

export type ClanSummaryDto = {
  /** Public tag, e.g. `QX7R2K`. */
  tag: string;
  name: string;
  description: string;
  badge: string;
  type: ClanType;
  minLevel: number;
  members: number;
  maxMembers: number;
  /** Sum of the members' campaign stars. */
  score: number;
};

export type ClanMemberDto = {
  /** Public player id (friend code). */
  code: string;
  nickname: string;
  avatarId: string;
  level: number;
  role: ClanRole;
  joinedAtUnix: number;
  /** Last sign-in of the account, unix seconds; absent when unknown. */
  lastSeenUnix?: number;
  /** Campaign stars of the member (what they add to the clan score). */
  stars: number;
};

export type ClanJoinRequestDto = { code: string; nickname: string; avatarId: string; level: number; sentAtUnix: number };

export type ClanDonationDto = {
  /** Public id of the member asking. */
  code: string;
  nickname: string;
  itemId: string;
  cardId: string;
  requested: number;
  received: number;
  createdAtUnix: number;
  expiresAtUnix: number;
  /** It is my own request. */
  mine: boolean;
  /** Tokens I already gave to it. */
  myDonations: number;
  /** I could donate right now (not mine, not full, not expired, below my limit for this request and for today). */
  canDonate: boolean;
};

export type MyClanDto = ClanSummaryDto & {
  /** Internal id: the chat channel is `clan:<id>`. */
  id: string;
  channel: string;
  createdAtUnix: number;
  /** 1 + the clans with a higher score (cached for a minute). */
  rank: number;
  myRole: ClanRole;
  roster: ClanMemberDto[];
  /** Pending join requests, only for leaders and co-leaders. */
  requests: ClanJoinRequestDto[];
  /** Donation requests of the clan's members (open and recently filled). */
  donations: ClanDonationDto[];
};

export type ClanLimitsDto = {
  maxMembers: number;
  createCostCoins: number;
  nameMinLength: number;
  nameMaxLength: number;
  descriptionMaxLength: number;
  maxMinLevel: number;
  badges: number;
  donation: ClansConfig["donation"];
};

export type ClanInfoDto = {
  myCode: string;
  /** My clan; null while I am in none. */
  clan: MyClanDto | null;
  /** The clan I asked to join (request clans), if any. */
  pendingRequest: ClanSummaryDto | null;
  /** Clans I could join (only when I am in none). */
  recommended: ClanSummaryDto[];
  donation: {
    /** When I can ask for tokens again (unix seconds, 0 = now). */
    nextRequestAtUnix: number;
    /** Tokens I donated today (UTC). */
    donatedToday: number;
  };
  limits: ClanLimitsDto;
};

export type ClanCreateDto = ClanInfoDto & { wallet: WalletDto };
export type ClanDonateDto = ClanInfoDto & { wallet: WalletDto; items: ItemAmounts; rewardCoins: number };

export type ClanCardDto = ClanSummaryDto & { createdAtUnix: number; rank: number; roster: ClanMemberDto[] };

export type ClanRankingEntryDto = ClanSummaryDto & { rank: number };

export type ClanRankingDto = {
  top: ClanRankingEntryDto[];
  /** My clan's row (also outside the top); null when I am in none. */
  me: ClanRankingEntryDto | null;
  refreshedAtUnix: number;
};

export type ClanSettingsInput = { description: string; badge: string; type: ClanType; minLevel: number };
export type ClanCreateInput = ClanSettingsInput & { name: string };

type CachedRanking = { loadedAtMs: number; rows: Array<{ clan: ClanRow; rank: number; members: number; score: number }> };

const unix = (date: Date) => Math.floor(date.getTime() / 1000);
const utcDay = (date: Date) => date.toISOString().slice(0, 10);
const canManage = (role: ClanRole) => role !== "member";

/** `#qx7r2k`, ` QX7R2K ` or the look-alikes `QX7R2K` with O / I / L typed → the canonical upper-case tag, or null. */
export function normalizeClanTag(raw: string): string | null {
  const tag = raw.trim().replace(/^#/, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  if (tag.length !== CLAN_TAG_LENGTH) return null;
  for (const char of tag) if (!CLAN_TAG_ALPHABET.includes(char)) return null;
  return tag;
}

export function randomClanTag(): string {
  let tag = "";
  for (let i = 0; i < CLAN_TAG_LENGTH; i++) tag += CLAN_TAG_ALPHABET[randomInt(CLAN_TAG_ALPHABET.length)];
  return tag;
}

export class ClansService {
  private readonly rankingCache: { value: CachedRanking | null; loading: Promise<CachedRanking> | null } = { value: null, loading: null };
  private readonly standings = new Map<string, { loadedAtMs: number; standing: ClanStanding }>();

  constructor(
    private readonly clans: ClansRepository,
    private readonly profiles: ProfileRepository,
    private readonly wallets: WalletLedger,
    private readonly inventory: InventoryLedger,
    private readonly collection: CollectionRepository,
    private readonly catalog: BattleCatalog,
    private readonly chat: ClanChatPort,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly config: ClansConfig = CLANS_CONFIG,
    private readonly generateTag: () => string = randomClanTag,
  ) {}

  // ------------------------------------------------------------------ reads

  /** My clan with its roster (or no clan, a pending request and recommendations), the donation state and the limits. */
  async info(userId: string): Promise<ClanInfoDto> {
    const now = this.clock.now();
    const member = await this.clans.getMember(userId);
    const clan = member ? await this.clans.getClan(member.clanId) : null;
    const base = { myCode: publicUserId(userId), limits: this.limits(), donation: await this.donationState(userId, now) };
    if (!member || !clan) {
      const pending = await this.clans.getJoinRequest(userId, this.requestCutoff(now));
      const pendingClan = pending ? await this.clans.getClan(pending.clanId) : null;
      const level = (await this.profiles.getProfile(userId))?.level ?? 1;
      return {
        ...base,
        clan: null,
        pendingRequest: pendingClan ? (await this.summaries([pendingClan]))[0]! : null,
        recommended: await this.recommended(level),
      };
    }
    return { ...base, clan: await this.myClan(userId, clan, member, now), pendingRequest: null, recommended: [] };
  }

  /** Open / request clans whose name starts with the query, plus the clan with that exact tag. */
  async search(_userId: string, query: string): Promise<{ clans: ClanSummaryDto[] }> {
    const text = query.trim();
    const rows: ClanRow[] = [];
    const tag = normalizeClanTag(text);
    if (tag) {
      const exact = await this.clans.getClanByTag(tag);
      if (exact && exact.type !== "closed") rows.push(exact);
    }
    for (const row of await this.clans.searchByName(text.toLowerCase(), this.config.searchLimit)) {
      if (!rows.some((existing) => existing.id === row.id)) rows.push(row);
    }
    return { clans: await this.summaries(rows.slice(0, this.config.searchLimit)) };
  }

  /** Public card of any clan (closed ones included) with its roster. */
  async view(_userId: string, rawTag: string): Promise<{ clan: ClanCardDto }> {
    const clan = await this.clanByTag(rawTag);
    const members = await this.clans.listMembers(clan.id);
    const [summary] = await this.summaries([clan]);
    const standing = await this.standingOf(clan.id);
    return {
      clan: {
        ...summary!,
        createdAtUnix: unix(clan.createdAt),
        rank: standing ? standing.better + 1 : 0,
        roster: await this.roster(members),
      },
    };
  }

  /** The best clans by score (cached for a minute) and my clan's row. */
  async ranking(userId: string): Promise<ClanRankingDto> {
    const cached = await this.topRanking();
    const top = cached.rows.map((row): ClanRankingEntryDto => this.rankingEntry(row.clan, row.members, row.score, row.rank));
    const member = await this.clans.getMember(userId);
    let me: ClanRankingEntryDto | null = null;
    if (member) {
      const clan = await this.clans.getClan(member.clanId);
      // Live (not cached) like the player's own row of the other leaderboards.
      const standing = clan ? await this.clans.standing(clan.id) : null;
      if (clan && standing) {
        const members = (await this.clans.memberCounts([clan.id])).get(clan.id) ?? 0;
        me = this.rankingEntry(clan, members, standing.score, standing.better + 1);
      }
    }
    return { top, me, refreshedAtUnix: Math.floor(cached.loadedAtMs / 1000) };
  }

  // ------------------------------------------------------------------ membership

  /** Creates a clan (costs coins) and makes me its leader. */
  async create(userId: string, input: ClanCreateInput): Promise<ClanCreateDto> {
    const name = this.validateName(input.name);
    const settings = this.validateSettings(input);
    const now = this.clock.now();
    const created = await this.uow.transaction(async (session) => {
      if (await this.clans.getMember(userId, session, true)) throw new AppError(ErrorCode.CLAN_ALREADY_MEMBER);
      if (await this.clans.nameExists(name.toLowerCase(), session)) throw new AppError(ErrorCode.CLAN_NAME_TAKEN);
      // Spend first: a short wallet fails here, before anything of the clan is written.
      await this.wallets.debit(session, userId, { coins: this.config.createCostCoins }, "CLAN_CREATE");
      let clan: ClanRow | null = null;
      for (let attempt = 0; attempt < 8 && !clan; attempt++) {
        const candidate: ClanRow = { id: randomUUID(), tag: this.generateTag(), name, ...settings, createdAt: now };
        if (await this.clans.insertClan(candidate, session)) clan = candidate;
        else if (await this.clans.nameExists(name.toLowerCase(), session)) throw new AppError(ErrorCode.CLAN_NAME_TAKEN);
      }
      if (!clan) throw new Error("Could not generate a unique clan tag.");
      if (!(await this.clans.insertMember({ userId, clanId: clan.id, role: "leader", joinedAt: now }, session))) throw new AppError(ErrorCode.CLAN_ALREADY_MEMBER);
      await this.clans.deleteJoinRequest(userId, session);
      return clan;
    });
    const founder = await this.nicknameOf(userId);
    this.chat.announce(created.id, `${founder} founded the clan.`, "clan_founded", [founder]);
    return { ...(await this.info(userId)), wallet: await this.wallets.snapshot(userId) };
  }

  /** Joins an open clan at once, or asks a `request` clan. */
  async join(userId: string, rawTag: string): Promise<ClanInfoDto> {
    const target = await this.clanByTag(rawTag);
    const now = this.clock.now();
    const joined = await this.uow.transaction(async (session) => {
      if (await this.clans.getMember(userId, session, true)) throw new AppError(ErrorCode.CLAN_ALREADY_MEMBER);
      const clan = await this.clans.getClan(target.id, session, true);
      if (!clan) throw new AppError(ErrorCode.CLAN_NOT_FOUND);
      if (clan.type === "closed") throw new AppError(ErrorCode.CLAN_CLOSED);
      const level = (await this.profiles.getProfile(userId, session))?.level ?? 1;
      if (level < clan.minLevel) throw new AppError(ErrorCode.CLAN_LEVEL_TOO_LOW, { extra: { minLevel: clan.minLevel } });
      await this.assertRoom(clan.id, session);
      if (clan.type === "open") {
        if (!(await this.clans.insertMember({ userId, clanId: clan.id, role: "member", joinedAt: now }, session))) throw new AppError(ErrorCode.CLAN_ALREADY_MEMBER);
        await this.clans.deleteJoinRequest(userId, session);
        return true;
      }
      if (await this.clans.getJoinRequest(userId, this.requestCutoff(now), session)) throw new AppError(ErrorCode.CLAN_REQUEST_PENDING);
      // An expired request still occupies the player's row: clear it before asking again.
      await this.clans.deleteJoinRequest(userId, session);
      if (!(await this.clans.insertJoinRequest({ userId, clanId: clan.id, createdAt: now }, session))) throw new AppError(ErrorCode.CLAN_REQUEST_PENDING);
      return false;
    });
    if (joined) {
      const name = await this.nicknameOf(userId);
      this.chat.announce(target.id, `${name} joined the clan.`, "clan_joined", [name]);
    }
    return this.info(userId);
  }

  /** Takes back my own join request. */
  async cancelRequest(userId: string): Promise<ClanInfoDto> {
    const removed = await this.uow.transaction((session) => this.clans.deleteJoinRequest(userId, session));
    if (!removed) throw new AppError(ErrorCode.CLAN_REQUEST_UNKNOWN);
    return this.info(userId);
  }

  /** Accepts the join request of the player `code` (leaders and co-leaders). */
  async accept(userId: string, code: string): Promise<ClanInfoDto> {
    const now = this.clock.now();
    const outcome = await this.uow.transaction(async (session) => {
      const actor = await this.requireManager(userId, session);
      await this.clans.getClan(actor.clanId, session, true);
      const request = this.findByCode(await this.clans.listJoinRequests(actor.clanId, this.requestCutoff(now), session), code);
      if (!request) throw new AppError(ErrorCode.CLAN_REQUEST_UNKNOWN);
      if (await this.clans.getMember(request.userId, session, true)) {
        // The applicant joined another clan meanwhile: drop the stale request (committed), then report it.
        await this.clans.deleteJoinRequest(request.userId, session);
        return { stale: true as const, clanId: actor.clanId, userId: request.userId };
      }
      await this.assertRoom(actor.clanId, session);
      await this.clans.deleteJoinRequest(request.userId, session);
      if (!(await this.clans.insertMember({ userId: request.userId, clanId: actor.clanId, role: "member", joinedAt: now }, session))) {
        return { stale: true as const, clanId: actor.clanId, userId: request.userId };
      }
      return { stale: false as const, clanId: actor.clanId, userId: request.userId };
    });
    if (outcome.stale) throw new AppError(ErrorCode.CLAN_REQUEST_UNKNOWN);
    const joinedName = await this.nicknameOf(outcome.userId);
    this.chat.announce(outcome.clanId, `${joinedName} joined the clan.`, "clan_joined", [joinedName]);
    return this.info(userId);
  }

  /** Declines the join request of the player `code` (leaders and co-leaders). */
  async decline(userId: string, code: string): Promise<ClanInfoDto> {
    const now = this.clock.now();
    await this.uow.transaction(async (session) => {
      const actor = await this.requireManager(userId, session);
      const request = this.findByCode(await this.clans.listJoinRequests(actor.clanId, this.requestCutoff(now), session), code);
      if (!request) throw new AppError(ErrorCode.CLAN_REQUEST_UNKNOWN);
      await this.clans.deleteJoinRequest(request.userId, session);
    });
    return this.info(userId);
  }

  /**
   * Leaves the clan. A leaving leader hands the clan to the oldest co-leader, else the oldest member; the last member
   * leaving deletes the clan.
   */
  async leave(userId: string): Promise<ClanInfoDto> {
    const outcome = await this.uow.transaction(async (session) => {
      const me = await this.clans.getMember(userId, session, true);
      if (!me) throw new AppError(ErrorCode.CLAN_NOT_MEMBER);
      await this.clans.getClan(me.clanId, session, true);
      const members = await this.clans.listMembers(me.clanId, session);
      const others = members.filter((member) => member.userId !== userId);
      if (others.length === 0) {
        await this.clans.deleteClan(me.clanId, session);
        return { clanId: me.clanId, deleted: true, successor: null as string | null };
      }
      await this.clans.deleteMember(userId, me.clanId, session);
      let successor: string | null = null;
      if (me.role === "leader") {
        const next = others.find((member) => member.role === "co_leader") ?? others[0]!;
        await this.clans.setRole(next.userId, "leader", session);
        successor = next.userId;
      }
      return { clanId: me.clanId, deleted: false, successor };
    });
    this.standings.delete(outcome.clanId);
    if (outcome.deleted) {
      this.chat.close(outcome.clanId);
    } else {
      this.chat.evict(outcome.clanId, userId);
      const leaver = await this.nicknameOf(userId);
      this.chat.announce(outcome.clanId, `${leaver} left the clan.`, "clan_left", [leaver]);
      if (outcome.successor) {
        const leader = await this.nicknameOf(outcome.successor);
        this.chat.announce(outcome.clanId, `${leader} is the new leader.`, "clan_new_leader", [leader]);
      }
    }
    return this.info(userId);
  }

  /** Removes a member: the leader kicks anyone, a co-leader kicks plain members only. */
  async kick(userId: string, code: string): Promise<ClanInfoDto> {
    const outcome = await this.uow.transaction(async (session) => {
      const actor = await this.requireManager(userId, session);
      await this.clans.getClan(actor.clanId, session, true);
      const target = this.findByCode(await this.clans.listMembers(actor.clanId, session), code);
      if (!target) throw new AppError(ErrorCode.CLAN_NOT_MEMBER);
      if (target.userId === userId) throw new AppError(ErrorCode.CLAN_FORBIDDEN);
      if (actor.role !== "leader" && target.role !== "member") throw new AppError(ErrorCode.CLAN_FORBIDDEN);
      await this.clans.deleteMember(target.userId, actor.clanId, session);
      return { clanId: actor.clanId, targetId: target.userId };
    });
    this.chat.evict(outcome.clanId, outcome.targetId);
    const removed = await this.nicknameOf(outcome.targetId);
    this.chat.announce(outcome.clanId, `${removed} was removed from the clan.`, "clan_removed", [removed]);
    return this.info(userId);
  }

  /**
   * Leader only. A member becomes co-leader; promoting a co-leader hands the leadership over (I become co-leader).
   */
  async promote(userId: string, code: string): Promise<ClanInfoDto> {
    const outcome = await this.uow.transaction(async (session) => {
      const actor = await this.requireLeader(userId, session);
      await this.clans.getClan(actor.clanId, session, true);
      const target = this.findByCode(await this.clans.listMembers(actor.clanId, session), code);
      if (!target) throw new AppError(ErrorCode.CLAN_NOT_MEMBER);
      if (target.userId === userId || target.role === "leader") throw new AppError(ErrorCode.CLAN_FORBIDDEN);
      if (target.role === "member") {
        await this.clans.setRole(target.userId, "co_leader", session);
        return { clanId: actor.clanId, targetId: target.userId, transfer: false };
      }
      await this.clans.setRole(target.userId, "leader", session);
      await this.clans.setRole(userId, "co_leader", session);
      return { clanId: actor.clanId, targetId: target.userId, transfer: true };
    });
    const nickname = await this.nicknameOf(outcome.targetId);
    if (outcome.transfer) this.chat.announce(outcome.clanId, `${nickname} is the new leader.`, "clan_new_leader", [nickname]);
    else this.chat.announce(outcome.clanId, `${nickname} was promoted to co-leader.`, "clan_promoted", [nickname]);
    return this.info(userId);
  }

  /** Leader only: a co-leader goes back to member. */
  async demote(userId: string, code: string): Promise<ClanInfoDto> {
    const outcome = await this.uow.transaction(async (session) => {
      const actor = await this.requireLeader(userId, session);
      await this.clans.getClan(actor.clanId, session, true);
      const target = this.findByCode(await this.clans.listMembers(actor.clanId, session), code);
      if (!target) throw new AppError(ErrorCode.CLAN_NOT_MEMBER);
      if (target.role !== "co_leader") throw new AppError(ErrorCode.CLAN_FORBIDDEN);
      await this.clans.setRole(target.userId, "member", session);
      return { clanId: actor.clanId, targetId: target.userId };
    });
    const demoted = await this.nicknameOf(outcome.targetId);
    this.chat.announce(outcome.clanId, `${demoted} was demoted to member.`, "clan_demoted", [demoted]);
    return this.info(userId);
  }

  /** Changes description, badge, type and level gate (leader and co-leaders). The name is fixed. */
  async edit(userId: string, input: ClanSettingsInput): Promise<ClanInfoDto> {
    const settings = this.validateSettings(input);
    await this.uow.transaction(async (session) => {
      const actor = await this.requireManager(userId, session);
      await this.clans.getClan(actor.clanId, session, true);
      await this.clans.updateClan(actor.clanId, settings, session);
    });
    return this.info(userId);
  }

  // ------------------------------------------------------------------ donations

  /** Asks the clan for tokens of a card I own (one request per cooldown). */
  async requestDonation(userId: string, itemId: string, amount?: number): Promise<ClanInfoDto> {
    const donation = this.config.donation;
    const item = this.catalog.items.get(itemId);
    // Crew tokens only: seeds of one card (wild tokens, materials and XP have no card and are not donatable).
    if (!item || item.kind !== "seed" || !item.card) throw new AppError(ErrorCode.CLAN_DONATION_UNKNOWN);
    const asked = amount === undefined ? donation.maxRequestAmount : amount;
    if (!Number.isInteger(asked) || asked < 1 || asked > donation.maxRequestAmount) throw new AppError(ErrorCode.INVALID_PAYLOAD);
    const now = this.clock.now();
    await this.uow.transaction(async (session) => {
      const member = await this.clans.getMember(userId, session, true);
      if (!member) throw new AppError(ErrorCode.CLAN_NOT_MEMBER);
      if (!(await this.collection.getCard(userId, item.card, session))) throw new AppError(ErrorCode.CARD_NOT_OWNED);
      const last = await this.clans.latestDonationRequest(userId, session);
      const next = last ? last.createdAt.getTime() + donation.requestCooldownHours * HOUR_MS : 0;
      if (next > now.getTime()) throw new AppError(ErrorCode.CLAN_DONATION_LIMIT, { extra: { nextAtUnix: Math.ceil(next / 1000) } });
      await this.clans.insertDonationRequest({ id: randomUUID(), clanId: member.clanId, userId, itemId, requested: asked, received: 0, createdAt: now }, session);
    });
    return this.info(userId);
  }

  /**
   * Gives one token of a member's open request out of my inventory (one transaction: my debit, their credit, my coin
   * reward and the counters). Limits: per donor per request and per UTC day.
   */
  async donate(userId: string, code: string): Promise<ClanDonateDto> {
    const donation = this.config.donation;
    const now = this.clock.now();
    await this.uow.transaction(async (session) => {
      const me = await this.clans.getMember(userId, session, true);
      if (!me) throw new AppError(ErrorCode.CLAN_NOT_MEMBER);
      const requester = this.findByCode(await this.clans.listMembers(me.clanId, session), code);
      if (!requester || requester.userId === userId) throw new AppError(ErrorCode.CLAN_DONATION_UNKNOWN);
      const latest = await this.clans.latestDonationRequest(requester.userId, session);
      const request = latest ? await this.clans.getDonationRequest(latest.id, session, true) : null;
      if (!request || request.clanId !== me.clanId || this.donationExpiry(request) <= now.getTime() || request.received >= request.requested) {
        throw new AppError(ErrorCode.CLAN_DONATION_UNKNOWN);
      }
      const given = (await this.clans.donationsByDonor([request.id], userId, session)).get(request.id) ?? 0;
      if (given >= donation.maxPerDonorPerRequest) {
        throw new AppError(ErrorCode.CLAN_DONATION_LIMIT, { extra: { nextAtUnix: Math.ceil(this.donationExpiry(request) / 1000) } });
      }
      const day = utcDay(now);
      if (await this.clans.countDonationsOn(userId, day, session) >= donation.maxPerDonorPerDay) {
        throw new AppError(ErrorCode.CLAN_DONATION_LIMIT, { extra: { nextAtUnix: Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000) } });
      }
      // Ledgers first (they can refuse), then the clan counters.
      await this.inventory.debit(session, userId, { [request.itemId]: 1 }, "CLAN_DONATION");
      await this.inventory.credit(session, request.userId, { [request.itemId]: 1 }, "CLAN_DONATION");
      await this.wallets.credit(session, userId, { coins: donation.rewardCoins }, "CLAN_DONATION");
      await this.clans.insertDonation({ id: randomUUID(), requestId: request.id, donorId: userId, day, createdAt: now }, session);
      await this.clans.addReceived(request.id, session);
    });
    return {
      ...(await this.info(userId)),
      wallet: await this.wallets.snapshot(userId),
      items: await this.inventory.snapshot(userId),
      rewardCoins: donation.rewardCoins,
    };
  }

  // ------------------------------------------------------------------ internals

  private limits(): ClanLimitsDto {
    const { maxMembers, createCostCoins, nameMinLength, nameMaxLength, descriptionMaxLength, maxMinLevel, donation } = this.config;
    return { maxMembers, createCostCoins, nameMinLength, nameMaxLength, descriptionMaxLength, maxMinLevel, badges: CLAN_BADGES.length, donation };
  }

  private requestCutoff(now: Date): Date {
    return new Date(now.getTime() - this.config.requestTtlDays * DAY_MS);
  }

  private donationExpiry(request: DonationRequestRow): number {
    return request.createdAt.getTime() + this.config.donation.requestCooldownHours * HOUR_MS;
  }

  private async donationState(userId: string, now: Date): Promise<ClanInfoDto["donation"]> {
    const last = await this.clans.latestDonationRequest(userId);
    const next = last ? last.createdAt.getTime() + this.config.donation.requestCooldownHours * HOUR_MS : 0;
    return {
      nextRequestAtUnix: next > now.getTime() ? Math.ceil(next / 1000) : 0,
      donatedToday: await this.clans.countDonationsOn(userId, utcDay(now)),
    };
  }

  private async nicknameOf(userId: string): Promise<string> {
    return (await this.profiles.getProfile(userId))?.nickname ?? "Player";
  }

  private async clanByTag(rawTag: string): Promise<ClanRow> {
    const tag = normalizeClanTag(rawTag);
    const clan = tag ? await this.clans.getClanByTag(tag) : null;
    if (!clan) throw new AppError(ErrorCode.CLAN_NOT_FOUND);
    return clan;
  }

  private findByCode<T extends { userId: string }>(rows: readonly T[], code: string): T | undefined {
    const wanted = code.trim().toUpperCase();
    return rows.find((row) => publicUserId(row.userId) === wanted);
  }

  private async requireManager(userId: string, session: DbSession): Promise<ClanMemberRow> {
    const member = await this.clans.getMember(userId, session, true);
    if (!member) throw new AppError(ErrorCode.CLAN_NOT_MEMBER);
    if (!canManage(member.role)) throw new AppError(ErrorCode.CLAN_FORBIDDEN);
    return member;
  }

  private async requireLeader(userId: string, session: DbSession): Promise<ClanMemberRow> {
    const member = await this.clans.getMember(userId, session, true);
    if (!member) throw new AppError(ErrorCode.CLAN_NOT_MEMBER);
    if (member.role !== "leader") throw new AppError(ErrorCode.CLAN_FORBIDDEN);
    return member;
  }

  private async assertRoom(clanId: string, session: DbSession): Promise<void> {
    const members = (await this.clans.memberCounts([clanId], session)).get(clanId) ?? 0;
    if (members >= this.config.maxMembers) throw new AppError(ErrorCode.CLAN_FULL, { extra: { max: this.config.maxMembers } });
  }

  /** Trimmed name that follows the nickname character rules (3-20 characters, unique ignoring case; uniqueness is checked on write). */
  private validateName(raw: string): string {
    const name = raw.trim();
    const length = [...name].length;
    if (length < this.config.nameMinLength || length > this.config.nameMaxLength) throw new AppError(ErrorCode.CLAN_NAME_INVALID);
    if (NAME_FORBIDDEN.test(name) || !NICKNAME_RULES.allowed.test(name) || name.includes("  ") || NICKNAME_RULES.reserved.test(name)) {
      throw new AppError(ErrorCode.CLAN_NAME_INVALID);
    }
    return name;
  }

  private validateSettings(input: ClanSettingsInput): { description: string; badge: string; type: ClanType; minLevel: number } {
    const description = input.description.replace(/\s+/gu, " ").replace(DESCRIPTION_FORBIDDEN, "").trim();
    if ([...description].length > this.config.descriptionMaxLength) throw new AppError(ErrorCode.INVALID_PAYLOAD);
    if (!CLAN_BADGES.includes(input.badge)) throw new AppError(ErrorCode.INVALID_PAYLOAD);
    if (!Number.isInteger(input.minLevel) || input.minLevel < 0 || input.minLevel > this.config.maxMinLevel) throw new AppError(ErrorCode.INVALID_PAYLOAD);
    return { description, badge: input.badge, type: input.type, minLevel: input.minLevel };
  }

  private toSummary(clan: ClanRow, members: number, score: number): ClanSummaryDto {
    return {
      tag: clan.tag, name: clan.name, description: clan.description, badge: clan.badge, type: clan.type, minLevel: clan.minLevel,
      members, maxMembers: this.config.maxMembers, score,
    };
  }

  private async summaries(rows: readonly ClanRow[]): Promise<ClanSummaryDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const counts = await this.clans.memberCounts(ids);
    const scores = await this.clans.scores(ids);
    return rows.map((row) => this.toSummary(row, counts.get(row.id) ?? 0, scores.get(row.id) ?? 0));
  }

  /** Joinable clans the player could enter, the fullest-but-not-full first. */
  private async recommended(level: number): Promise<ClanSummaryDto[]> {
    const candidates = await this.clans.listJoinable(level, 100);
    const counts = await this.clans.memberCounts(candidates.map((row) => row.id));
    const open = candidates.filter((row) => (counts.get(row.id) ?? 0) < this.config.maxMembers);
    open.sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
    return this.summaries(open.slice(0, this.config.recommendedLimit));
  }

  /** Roster of the members (leader first, then co-leaders, then by stars). */
  private async roster(members: readonly ClanMemberRow[]): Promise<ClanMemberDto[]> {
    const ids = members.map((member) => member.userId);
    const players = await this.clans.players(ids);
    const stars = await this.clans.stars(ids);
    const roster: ClanMemberDto[] = [];
    for (const member of members) {
      const player = players.get(member.userId);
      if (!player) continue;
      roster.push(memberDto(member, player, stars.get(member.userId) ?? 0));
    }
    roster.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || b.stars - a.stars || a.joinedAtUnix - b.joinedAtUnix || a.code.localeCompare(b.code));
    return roster;
  }

  private async myClan(userId: string, clan: ClanRow, me: ClanMemberRow, now: Date): Promise<MyClanDto> {
    const members = await this.clans.listMembers(clan.id);
    const roster = await this.roster(members);
    const score = roster.reduce((sum, member) => sum + member.stars, 0);
    const standing = await this.standingOf(clan.id);

    let requests: ClanJoinRequestDto[] = [];
    if (canManage(me.role)) {
      const rows = await this.clans.listJoinRequests(clan.id, this.requestCutoff(now));
      const players = await this.clans.players(rows.map((row) => row.userId));
      requests = rows.flatMap((row): ClanJoinRequestDto[] => {
        const player = players.get(row.userId);
        return player ? [{ code: publicUserId(row.userId), nickname: player.nickname, avatarId: player.avatarId, level: player.level, sentAtUnix: unix(row.createdAt) }] : [];
      });
    }

    const since = new Date(now.getTime() - this.config.donation.requestCooldownHours * HOUR_MS);
    const donationRows = (await this.clans.listDonationRequests(clan.id, since)).filter((row) => members.some((member) => member.userId === row.userId));
    const given = await this.clans.donationsByDonor(donationRows.map((row) => row.id), userId);
    const today = await this.clans.countDonationsOn(userId, utcDay(now));
    const donations: ClanDonationDto[] = [];
    for (const row of donationRows) {
      const requester = roster.find((member) => member.code === publicUserId(row.userId));
      const item = this.catalog.items.get(row.itemId);
      if (!requester || !item) continue;
      const myDonations = given.get(row.id) ?? 0;
      const mine = row.userId === userId;
      donations.push({
        code: requester.code, nickname: requester.nickname, itemId: row.itemId, cardId: item.card, requested: row.requested, received: row.received,
        createdAtUnix: unix(row.createdAt), expiresAtUnix: Math.floor(this.donationExpiry(row) / 1000), mine, myDonations,
        canDonate: !mine && row.received < row.requested && myDonations < this.config.donation.maxPerDonorPerRequest && today < this.config.donation.maxPerDonorPerDay,
      });
    }

    return {
      ...this.toSummary(clan, members.length, score),
      id: clan.id,
      channel: clanChannel(clan.id),
      createdAtUnix: unix(clan.createdAt),
      rank: standing ? standing.better + 1 : 1,
      myRole: me.role,
      roster,
      requests,
      donations,
    };
  }

  /** The clan's score and clans above it, cached for a minute per clan. */
  private async standingOf(clanId: string): Promise<ClanStanding | null> {
    const nowMs = this.clock.nowMs();
    const cached = this.standings.get(clanId);
    if (cached && nowMs - cached.loadedAtMs < this.config.rankingCacheSeconds * 1000) return cached.standing;
    const standing = await this.clans.standing(clanId);
    if (!standing) return null;
    if (this.standings.size >= 5000) this.standings.clear();
    this.standings.set(clanId, { loadedAtMs: nowMs, standing });
    return standing;
  }

  private rankingEntry(clan: ClanRow, members: number, score: number, rank: number): ClanRankingEntryDto {
    return { ...this.toSummary(clan, members, score), rank };
  }

  private async topRanking(): Promise<CachedRanking> {
    const ttlMs = this.config.rankingCacheSeconds * 1000;
    const cached = this.rankingCache.value;
    if (cached && this.clock.nowMs() - cached.loadedAtMs < ttlMs) return cached;
    if (!this.rankingCache.loading) {
      this.rankingCache.loading = this.loadRanking()
        .then((loaded) => { this.rankingCache.value = loaded; return loaded; })
        .finally(() => { this.rankingCache.loading = null; });
    }
    return this.rankingCache.loading;
  }

  private async loadRanking(): Promise<CachedRanking> {
    const ranked: ClanRankRow[] = await this.clans.topClans(this.config.rankingTopSize);
    const rows = await this.clans.getClans(ranked.map((row) => row.clanId));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const result: CachedRanking["rows"] = [];
    ranked.forEach((row, index) => {
      const clan = byId.get(row.clanId);
      if (!clan) return;
      // Ties share the best rank (1 + the clans strictly above), like a clan's own standing.
      let first = index;
      while (first > 0 && ranked[first - 1]!.score === row.score) first--;
      result.push({ clan, rank: first + 1, members: row.members, score: row.score });
    });
    return { loadedAtMs: this.clock.nowMs(), rows: result };
  }
}

function memberDto(member: ClanMemberRow, player: ClanPlayerRow, stars: number): ClanMemberDto {
  return {
    code: publicUserId(member.userId),
    nickname: player.nickname,
    avatarId: player.avatarId,
    level: player.level,
    role: member.role,
    joinedAtUnix: unix(member.joinedAt),
    ...(player.lastLoginAt ? { lastSeenUnix: unix(player.lastLoginAt) } : {}),
    stars,
  };
}
