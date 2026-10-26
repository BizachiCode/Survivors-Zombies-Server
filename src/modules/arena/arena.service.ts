// Arena use cases (weekly arena). A season runs Monday to Monday (UTC). A player's first match of a season
// puts them in a group of their league; every match is an authoritative battle (mode "arena") whose score the server
// counts, and the group ranks its players by best score. When a new season starts, the player's previous season is
// settled the first time they come back: promotion / demotion by rank and the league's reward sent by mail.

import { randomUUID } from "node:crypto";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import { publicUserId } from "../../shared/kernel/public-id.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { localize, type Language, type LocalizedText } from "../../shared/localized.js";
import type { BattleMode, ModeBattle, ModeSettlement, PreparedBattle } from "../battle/battle-modes.js";
import type { BattleOutcome } from "../battle/battle-rules.js";
import type { BattleCatalog, StageDefinition } from "../battle/content/battle-content.js";
import type { RewardBundle } from "../economy/reward-granter.js";
import type { WalletDto, WalletLedger } from "../economy/wallet-ledger.js";
import type { MailDraft } from "../mail/mail.service.js";
import { arenaScore, seasonOf, type ArenaCatalog, type ArenaLeague } from "./arena-content.js";
import type { ArenaEntryRow, ArenaPlayerRow, ArenaRepository, ArenaStandingRow } from "./arena.repository.js";

export const ARENA_MODE = "arena";
const EMPTY: RewardBundle = { currencies: {}, items: {}, exp: 0 };
const MAIL_DAYS = 30;

/** Mail the arena sends (MailService.send). */
export type ArenaMailer = { send(session: DbSession, userId: string, draft: MailDraft): Promise<string> };

export type ArenaLeagueDto = {
  index: number;
  id: string;
  name: string;
  promote: number;
  demote: number;
  rewards: { fromRank: number; toRank: number; reward: RewardBundle }[];
};

export type ArenaEntryDto = { rank: number; code: string; nickname: string; avatarId: string; level: number; score: number; me: boolean };

export type ArenaSeasonResultDto = {
  seasonId: string;
  rank: number;
  groupSize: number;
  leagueBefore: { id: string; name: string };
  leagueAfter: { id: string; name: string };
  change: "promoted" | "demoted" | "stayed";
  reward: RewardBundle;
};

export type ArenaDto = {
  enabled: boolean;
  seasonId: string;
  startsAtUnix: number;
  endsAtUnix: number;
  title: string;
  league: ArenaLeagueDto | null;
  leagues: { id: string; name: string }[];
  tickets: number;
  maxTickets: number;
  /** 0 while full. */
  nextTicketAtUnix: number;
  ticketPrice: { currency: string; amount: number };
  scoring: ArenaCatalog["scoring"] | null;
  /** In a group this season (after the first match). */
  joined: boolean;
  bestScore: number;
  plays: number;
  rank: number;
  groupSize: number;
  group: ArenaEntryDto[];
  /** The season just settled (once, on the answer that settled it). */
  lastSeason: ArenaSeasonResultDto | null;
  wallet?: WalletDto;
};

/** What an arena battle adds to its result (`arena` in the battle result). */
export type ArenaMatchDto = { seasonId: string; score: number; bestScore: number; newBest: boolean; rank: number; groupSize: number; league: string };

export class ArenaService {
  readonly mode: BattleMode;

  constructor(
    private readonly catalog: BattleCatalog,
    private readonly arena: ArenaRepository,
    private readonly wallets: WalletLedger,
    private readonly mail: ArenaMailer,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {
    this.mode = new ArenaMode(this);
  }

  get content(): ArenaCatalog | null {
    return this.catalog.arena;
  }

  /** What an arena match of a season runs (the arena's encounter and difficulty, no campaign rewards). */
  matchStage(seasonId: string, lang?: string): StageDefinition {
    const content = this.require();
    return this.catalog.modeStage(`arena:${seasonId}`, localize(content.title, lang), content.encounter, content.difficulty);
  }

  async info(userId: string, lang?: string): Promise<ArenaDto> {
    const content = this.content;
    if (!content) return this.disabled();
    const lastSeason = await this.settlePrevious(userId, lang);
    return this.snapshot(userId, lang, lastSeason);
  }

  /** Buys one ticket with the content's price (WalletLedger, reason ARENA_TICKET), even beyond the maximum. */
  async buyTicket(userId: string, lang?: string): Promise<ArenaDto> {
    const content = this.require();
    const price = content.tickets.price;
    if (price.amount <= 0) throw new AppError(ErrorCode.ARENA_DISABLED, { message: "tickets can't be bought" });
    await this.uow.transaction(async (session) => {
      const player = await this.lockPlayer(userId, session);
      await this.wallets.debit(session, userId, { [price.currency]: price.amount }, "ARENA_TICKET");
      await this.arena.savePlayer({ ...player, tickets: player.tickets + 1 }, session);
    });
    return { ...(await this.snapshot(userId, lang, null)), wallet: await this.wallets.snapshot(userId) };
  }

  /** Spends a ticket and makes sure the player has a group this season (battle start). */
  async startMatch(userId: string): Promise<{ seasonId: string; bestScore: number; league: ArenaLeague }> {
    const content = this.require();
    await this.settlePrevious(userId, "en");
    const season = seasonOf(this.clock.nowMs());
    return this.uow.transaction(async (session) => {
      const player = await this.lockPlayer(userId, session);
      if (player.tickets < 1) {
        throw new AppError(ErrorCode.ARENA_NO_TICKETS, { extra: { nextTicketAtUnix: Math.floor(this.nextTicketAtMs(player) / 1000) } });
      }
      const full = player.tickets >= content.tickets.max;
      // A full stack starts regenerating from the moment a ticket is spent.
      await this.arena.savePlayer({ ...player, tickets: player.tickets - 1, ticketsAt: full ? new Date(this.clock.nowMs()) : player.ticketsAt }, session);
      const entry = await this.arena.getEntry(season.id, userId, session, true) ?? await this.join(season.id, player, session);
      return { seasonId: season.id, bestScore: entry.bestScore, league: content.league(entry.leagueIndex) };
    });
  }

  /** Counts a finished arena battle (inside the battle's result transaction). */
  async recordMatch(session: DbSession, userId: string, seasonId: string, outcome: BattleOutcome): Promise<ArenaMatchDto> {
    const content = this.require();
    const score = outcome.kind === "ABANDONED" ? 0 : arenaScore(content.scoring, {
      victory: outcome.kind === "VICTORY", kills: outcome.kills, waves: outcome.waves ?? 0, baseHealth: outcome.baseHealth,
    });
    const entry = await this.arena.getEntry(seasonId, userId, session, true);
    if (!entry) return { seasonId, score, bestScore: score, newBest: false, rank: 0, groupSize: 0, league: content.league(0).id };
    const newBest = score > entry.bestScore && !entry.settledAt;
    const next: ArenaEntryRow = {
      ...entry,
      plays: entry.plays + 1,
      bestScore: newBest ? score : entry.bestScore,
      bestAt: newBest ? new Date(this.clock.nowMs()) : entry.bestAt,
    };
    await this.arena.saveEntry(next, session);
    const standings = rankGroup(await this.arena.groupEntries(entry.groupId, session));
    const mine = standings.find((s) => s.userId === userId);
    return {
      seasonId, score, bestScore: next.bestScore, newBest, rank: mine?.rank ?? standings.length, groupSize: standings.length,
      league: content.league(entry.leagueIndex).id,
    };
  }

  // ------------------------------------------------------------------ internals
  private require(): ArenaCatalog {
    const content = this.content;
    if (!content) throw new AppError(ErrorCode.ARENA_DISABLED);
    return content;
  }

  private disabled(): ArenaDto {
    const season = seasonOf(this.clock.nowMs());
    return {
      enabled: false, seasonId: season.id, startsAtUnix: season.startsAtMs / 1000, endsAtUnix: season.endsAtMs / 1000, title: "", league: null,
      leagues: [], tickets: 0, maxTickets: 0, nextTicketAtUnix: 0, ticketPrice: { currency: "gems", amount: 0 }, scoring: null, joined: false,
      bestScore: 0, plays: 0, rank: 0, groupSize: 0, group: [], lastSeason: null,
    };
  }

  /** The player's arena row with the tickets regenerated up to now (created full the first time), locked. */
  private async lockPlayer(userId: string, session: DbSession): Promise<ArenaPlayerRow> {
    const stored = await this.arena.getPlayer(userId, session, true);
    const player = stored ?? { userId, leagueIndex: 0, tickets: this.require().tickets.max, ticketsAt: new Date(this.clock.nowMs()) };
    return this.regenerate(player);
  }

  private regenerate(player: ArenaPlayerRow): ArenaPlayerRow {
    const { max, regenMinutes } = this.require().tickets;
    const now = this.clock.nowMs();
    if (player.tickets >= max) return { ...player, ticketsAt: new Date(now) };
    const regenMs = regenMinutes * 60_000;
    const gained = Math.floor((now - player.ticketsAt.getTime()) / regenMs);
    if (gained <= 0) return player;
    const tickets = Math.min(max, player.tickets + gained);
    return { ...player, tickets, ticketsAt: tickets >= max ? new Date(now) : new Date(player.ticketsAt.getTime() + gained * regenMs) };
  }

  private nextTicketAtMs(player: ArenaPlayerRow): number {
    const { max, regenMinutes } = this.require().tickets;
    return player.tickets >= max ? 0 : player.ticketsAt.getTime() + regenMinutes * 60_000;
  }

  /** Puts the player in the oldest group of their league with room left (or a new one). */
  private async join(seasonId: string, player: ArenaPlayerRow, session: DbSession): Promise<ArenaEntryRow> {
    const content = this.require();
    const leagueIndex = Math.min(player.leagueIndex, content.leagues.length - 1);
    let group = await this.arena.lockOpenGroup(seasonId, leagueIndex, content.groupSize, session);
    if (!group) {
      group = { id: randomUUID(), seasonId, leagueIndex, members: 0 };
      await this.arena.insertGroup(group, session);
    }
    await this.arena.setGroupMembers(group.id, group.members + 1, session);
    const entry: ArenaEntryRow = { seasonId, userId: player.userId, groupId: group.id, leagueIndex, bestScore: 0, bestAt: null, plays: 0, settledAt: null };
    await this.arena.insertEntry(entry, session);
    return entry;
  }

  /** Settles every finished season the player took part in; returns the latest one settled now (or null). */
  private async settlePrevious(userId: string, lang?: string): Promise<ArenaSeasonResultDto | null> {
    const content = this.require();
    const current = seasonOf(this.clock.nowMs()).id;
    let latest: ArenaSeasonResultDto | null = null;
    for (const pending of await this.arena.unsettledBefore(userId, current)) {
      const result = await this.uow.transaction(async (session) => {
        const entry = await this.arena.getEntry(pending.seasonId, userId, session, true);
        if (!entry || entry.settledAt) return null;
        const standings = rankGroup(await this.arena.groupEntries(entry.groupId, session));
        const rank = standings.find((s) => s.userId === userId)?.rank ?? standings.length;
        const size = standings.length;
        const league = content.league(entry.leagueIndex);
        const top = content.leagues.length - 1;
        let leagueAfter = entry.leagueIndex;
        if (rank <= league.promote && entry.leagueIndex < top) leagueAfter++;
        else if (league.demote > 0 && entry.leagueIndex > 0 && rank > Math.max(league.promote, size - league.demote)) leagueAfter--;
        const player = await this.lockPlayer(userId, session);
        await this.arena.savePlayer({ ...player, leagueIndex: leagueAfter }, session);
        const reward = content.rewardFor(entry.leagueIndex, rank) ?? EMPTY;
        await this.mail.send(session, userId, this.seasonMail(entry.seasonId, rank, league, reward));
        await this.arena.saveEntry({ ...entry, settledAt: new Date(this.clock.nowMs()) }, session);
        const after = content.league(leagueAfter);
        return {
          seasonId: entry.seasonId, rank, groupSize: size, reward,
          leagueBefore: { id: league.id, name: localize(league.name, lang) },
          leagueAfter: { id: after.id, name: localize(after.name, lang) },
          change: leagueAfter > entry.leagueIndex ? "promoted" : leagueAfter < entry.leagueIndex ? "demoted" : "stayed",
        } satisfies ArenaSeasonResultDto;
      });
      if (result) latest = result;
    }
    return latest;
  }

  private seasonMail(seasonId: string, rank: number, league: ArenaLeague, reward: RewardBundle): MailDraft {
    const name = (lang: Language) => localize(league.name, lang);
    const body: LocalizedText = {
      en: `Season ${seasonId}: you finished #${rank} in your ${name("en")} group.`,
      pt: `Temporada ${seasonId}: você terminou em ${rank}º no seu grupo da liga ${name("pt")}.`,
      es: `Temporada ${seasonId}: terminaste en el puesto ${rank} de tu grupo de la liga ${name("es")}.`,
      zh: `${seasonId} 赛季：你在${name("zh")}联赛分组中排名第 ${rank}。`,
      ja: `シーズン ${seasonId}：${name("ja")}リーグのグループで ${rank} 位になりました。`,
      ko: `시즌 ${seasonId}: ${name("ko")} 리그 그룹에서 ${rank}위를 기록했습니다.`,
    };
    return {
      sender: "Arena",
      title: {
        en: "Arena season rewards", pt: "Recompensas da arena", es: "Recompensas de la arena",
        zh: "竞技场赛季奖励", ja: "アリーナシーズン報酬", ko: "아레나 시즌 보상",
      },
      body,
      attachments: reward,
      expiresAt: new Date(this.clock.nowMs() + MAIL_DAYS * 86_400_000),
    };
  }

  private async snapshot(userId: string, lang: string | undefined, lastSeason: ArenaSeasonResultDto | null): Promise<ArenaDto> {
    const content = this.require();
    const season = seasonOf(this.clock.nowMs());
    const stored = await this.arena.getPlayer(userId);
    const player = this.regenerate(stored ?? { userId, leagueIndex: 0, tickets: content.tickets.max, ticketsAt: new Date(this.clock.nowMs()) });
    const entry = await this.arena.getEntry(season.id, userId);
    const leagueIndex = entry ? entry.leagueIndex : Math.min(player.leagueIndex, content.leagues.length - 1);
    const standings = entry ? rankGroup(await this.arena.groupEntries(entry.groupId)) : [];
    const mine = standings.find((s) => s.userId === userId);
    return {
      enabled: true,
      seasonId: season.id,
      startsAtUnix: season.startsAtMs / 1000,
      endsAtUnix: season.endsAtMs / 1000,
      title: localize(content.title, lang),
      league: this.leagueDto(leagueIndex, lang),
      leagues: content.leagues.map((l) => ({ id: l.id, name: localize(l.name, lang) })),
      tickets: player.tickets,
      maxTickets: content.tickets.max,
      nextTicketAtUnix: Math.floor(this.nextTicketAtMs(player) / 1000),
      ticketPrice: content.tickets.price,
      scoring: content.scoring,
      joined: entry !== null,
      bestScore: entry?.bestScore ?? 0,
      plays: entry?.plays ?? 0,
      rank: mine?.rank ?? 0,
      groupSize: standings.length,
      group: standings.map((s) => ({
        rank: s.rank, code: publicUserId(s.userId), nickname: s.nickname, avatarId: s.avatarId, level: Number(s.level), score: s.bestScore, me: s.userId === userId,
      })),
      lastSeason,
    };
  }

  private leagueDto(index: number, lang?: string): ArenaLeagueDto {
    const league = this.require().league(index);
    let from = 1;
    return {
      index,
      id: league.id,
      name: localize(league.name, lang),
      promote: league.promote,
      demote: league.demote,
      rewards: league.rewards.map((tier) => {
        const dto = { fromRank: from, toRank: tier.toRank, reward: tier.reward };
        from = tier.toRank + 1;
        return dto;
      }),
    };
  }
}

/** Best score first; ties go to who reached it first; players without a score last. */
export function rankGroup(entries: ArenaStandingRow[]): (ArenaStandingRow & { rank: number })[] {
  const sorted = [...entries].sort((a, b) =>
    b.bestScore - a.bestScore
    || (a.bestAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.bestAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
    || a.userId.localeCompare(b.userId));
  return sorted.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/** The arena as a battle mode: target "" = the current season. */
class ArenaMode implements BattleMode {
  readonly id = ARENA_MODE;

  constructor(private readonly service: ArenaService) {}

  async prepare(userId: string, _target: string, _playerLevel: number, lang?: string): Promise<ModeBattle> {
    const content = this.service.content;
    if (!content) throw new AppError(ErrorCode.ARENA_DISABLED);
    const match = await this.service.startMatch(userId);
    return {
      stage: this.service.matchStage(match.seasonId, lang),
      context: { seasonId: match.seasonId },
      info: { arena: { seasonId: match.seasonId, scoring: content.scoring, bestScore: match.bestScore, league: match.league.id } },
    };
  }

  async settle(session: DbSession, battle: PreparedBattle, outcome: BattleOutcome): Promise<ModeSettlement> {
    const extra = await this.service.recordMatch(session, battle.userId, String(battle.context.seasonId), outcome);
    return { stars: 0, bestStars: 0, firstClear: false, reward: { ...EMPTY }, extra };
  }
}
