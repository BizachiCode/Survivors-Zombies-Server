// Objectives: progress counted from gameplay (record, called inside the features' transactions), the lists the client
// shows (daily / weekly missions, achievements, running events) and claiming their rewards. All periods are UTC.

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { localize } from "../../shared/localized.js";
import type { BattleCatalog } from "../battle/content/battle-content.js";
import type { InventoryLedger, ItemAmounts } from "../collection/inventory-ledger.js";
import type { RewardBundle, RewardGranter } from "../economy/reward-granter.js";
import type { WalletDto, WalletLedger } from "../economy/wallet-ledger.js";
import { toProfileDto } from "../profile/profile.mapper.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import {
  nextDayMs, nextWeekMs, periodOf, type MetricAmounts, type ObjectiveDefinition, type ObjectiveKind, type ProgressionCatalog,
} from "./objectives-content.js";
import type { ObjectiveProgressRow, ObjectivesRepository } from "./objectives.repository.js";

/** Reports what a player did (battles won, cards upgraded...) inside the feature's transaction. */
export interface ObjectiveRecorder {
  record(session: DbSession, userId: string, metrics: MetricAmounts): Promise<void>;
}

export const NO_RECORDER: ObjectiveRecorder = { record: async () => undefined };

export type ObjectiveDto = {
  id: string;
  kind: ObjectiveKind;
  title: string;
  description: string;
  metric: string;
  target: number;
  /** Capped at the target. */
  progress: number;
  completed: boolean;
  claimed: boolean;
  reward: RewardBundle;
  tier: number;
  /** Tiers of the achievement chain (1 for anything else). */
  tiers: number;
};

export type EventDto = {
  id: string;
  title: string;
  description: string;
  banner: string;
  startsAtUnix: number;
  endsAtUnix: number;
  objectives: ObjectiveDto[];
};

export type ObjectivesDto = {
  enabled: boolean;
  daily: { resetsAtUnix: number; objectives: ObjectiveDto[] };
  weekly: { resetsAtUnix: number; objectives: ObjectiveDto[] };
  achievements: ObjectiveDto[];
  events: EventDto[];
  /** Completed and unclaimed, per list (badges). */
  claimable: { daily: number; weekly: number; achievements: number; events: number };
};

export type ClaimDto = ObjectivesDto & {
  granted: RewardBundle;
  levelsGained: number;
  wallet: WalletDto;
  items: ItemAmounts;
  profile: ReturnType<typeof toProfileDto>;
};

export class ObjectiveService implements ObjectiveRecorder {
  constructor(
    private readonly catalog: BattleCatalog,
    private readonly repository: ObjectivesRepository,
    private readonly rewards: RewardGranter,
    private readonly wallets: WalletLedger,
    private readonly inventory: InventoryLedger,
    private readonly profiles: ProfileRepository,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  private get progression(): ProgressionCatalog | null {
    return this.catalog.progression;
  }

  /** Adds gameplay amounts to every objective counting them now (events only while they run). */
  async record(session: DbSession, userId: string, metrics: MetricAmounts): Promise<void> {
    const progression = this.progression;
    if (!progression) return;
    const now = this.clock.nowMs();
    const entries: { objectiveId: string; period: string; delta: number }[] = [];
    for (const objective of progression.objectives) {
      const delta = metrics[objective.metric] ?? 0;
      if (delta <= 0 || !this.isActive(objective, now)) continue;
      entries.push({ objectiveId: objective.id, period: periodOf(objective, now), delta: Math.floor(delta) });
    }
    if (entries.length > 0) await this.repository.increment(userId, entries, session);
  }

  async info(userId: string, lang?: string): Promise<ObjectivesDto> {
    const progression = this.progression;
    const now = this.clock.nowMs();
    const empty: ObjectivesDto = {
      enabled: false, daily: { resetsAtUnix: unix(nextDayMs(now)), objectives: [] }, weekly: { resetsAtUnix: unix(nextWeekMs(now)), objectives: [] },
      achievements: [], events: [], claimable: { daily: 0, weekly: 0, achievements: 0, events: 0 },
    };
    if (!progression) return empty;
    const level = (await this.profiles.getProfile(userId))?.level ?? 1;
    const visible = progression.objectives.filter((o) => this.isActive(o, now) && level >= o.requiredLevel);
    const periods = [...new Set(visible.map((o) => periodOf(o, now)))];
    const rows = new Map((await this.repository.listProgress(userId, periods)).map((r) => [`${r.objectiveId}|${r.period}`, r]));
    const dto = (o: ObjectiveDefinition): ObjectiveDto => this.toDto(o, rows.get(`${o.id}|${periodOf(o, now)}`), lang);

    const daily = visible.filter((o) => o.kind === "daily").map(dto);
    const weekly = visible.filter((o) => o.kind === "weekly").map(dto);
    const achievements = this.achievementList(visible.filter((o) => o.kind === "achievement"), dto);
    const events: EventDto[] = progression.events.filter((e) => progression.isRunning(e, now)).map((event) => ({
      id: event.id,
      title: localize(event.title, lang),
      description: localize(event.description, lang),
      banner: event.banner,
      startsAtUnix: unix(Date.parse(event.startsAt)),
      endsAtUnix: unix(Date.parse(event.endsAt)),
      objectives: visible.filter((o) => o.kind === "event" && o.event === event.id).map(dto),
    }));
    const claimable = (list: ObjectiveDto[]) => list.filter((o) => o.completed && !o.claimed).length;
    return {
      enabled: true,
      daily: { resetsAtUnix: unix(nextDayMs(now)), objectives: daily },
      weekly: { resetsAtUnix: unix(nextWeekMs(now)), objectives: weekly },
      achievements,
      events,
      claimable: {
        daily: claimable(daily), weekly: claimable(weekly), achievements: claimable(achievements),
        events: events.reduce((sum, e) => sum + claimable(e.objectives), 0),
      },
    };
  }

  /** Claims one completed objective's reward (once per period). */
  async claim(userId: string, objectiveId: string, lang?: string): Promise<ClaimDto> {
    const objective = this.progression?.objective(objectiveId);
    if (!objective) throw new AppError(ErrorCode.OBJECTIVE_UNKNOWN);
    const outcome = await this.uow.transaction(async (session) => this.claimOne(session, userId, objective));
    return this.claimAnswer(userId, lang, outcome.granted, outcome.levelsGained);
  }

  /** Claims every completed objective of a list (or of all lists), in one transaction. */
  async claimAll(userId: string, kind: ObjectiveKind | undefined, lang?: string): Promise<ClaimDto> {
    const progression = this.progression;
    if (!progression) throw new AppError(ErrorCode.OBJECTIVE_UNKNOWN);
    const now = this.clock.nowMs();
    const level = (await this.profiles.getProfile(userId))?.level ?? 1;
    const candidates = progression.objectives.filter((o) => (!kind || o.kind === kind) && this.isActive(o, now) && level >= o.requiredLevel);
    const rows = new Map((await this.repository.listProgress(userId, [...new Set(candidates.map((o) => periodOf(o, now)))]))
      .map((r) => [`${r.objectiveId}|${r.period}`, r]));
    const ready = candidates.filter((o) => {
      const row = rows.get(`${o.id}|${periodOf(o, now)}`);
      return row && !row.claimedAt && row.progress >= o.target;
    });
    const total: RewardBundle = { currencies: {}, items: {}, exp: 0 };
    let levelsGained = 0;
    await this.uow.transaction(async (session) => {
      for (const objective of ready) {
        const outcome = await this.claimOne(session, userId, objective);
        addReward(total, outcome.granted);
        levelsGained += outcome.levelsGained;
      }
    });
    return this.claimAnswer(userId, lang, total, levelsGained);
  }

  private async claimOne(session: DbSession, userId: string, objective: ObjectiveDefinition): Promise<{ granted: RewardBundle; levelsGained: number }> {
    const now = this.clock.nowMs();
    const level = (await this.profiles.getProfile(userId, session))?.level ?? 1;
    if (!this.isActive(objective, now) || level < objective.requiredLevel) throw new AppError(ErrorCode.OBJECTIVE_INACTIVE);
    const period = periodOf(objective, now);
    const row = await this.repository.lockProgress(userId, objective.id, period, session);
    if (row?.claimedAt) throw new AppError(ErrorCode.OBJECTIVE_CLAIMED);
    const progress = row?.progress ?? 0;
    if (progress < objective.target) throw new AppError(ErrorCode.OBJECTIVE_NOT_COMPLETED, { extra: { progress, target: objective.target } });
    // A chain's tiers are claimed in order.
    if (objective.kind === "achievement" && objective.group) {
      const lower = this.progression.objectives.filter((o) => o.kind === "achievement" && o.group === objective.group && o.tier < objective.tier);
      for (const previous of lower) {
        const previousRow = await this.repository.lockProgress(userId, previous.id, "A", session);
        if (!previousRow?.claimedAt) throw new AppError(ErrorCode.OBJECTIVE_INACTIVE);
      }
    }
    await this.repository.markClaimed(userId, objective.id, period, new Date(now), session);
    const { levelsGained } = await this.rewards.grant(session, userId, objective.reward, "OBJECTIVE_REWARD");
    return { granted: objective.reward, levelsGained };
  }

  private async claimAnswer(userId: string, lang: string | undefined, granted: RewardBundle, levelsGained: number): Promise<ClaimDto> {
    const profile = await this.profiles.getProfile(userId);
    return {
      ...(await this.info(userId, lang)),
      granted,
      levelsGained,
      wallet: await this.wallets.snapshot(userId),
      items: await this.inventory.snapshot(userId),
      profile: toProfileDto(profile),
    };
  }

  /** Daily and weekly always count, achievements always, event objectives while their event runs. */
  private isActive(objective: ObjectiveDefinition, nowMs: number): boolean {
    if (objective.kind !== "event") return true;
    const event = this.progression?.event(objective.event);
    return !!event && this.progression.isRunning(event, nowMs);
  }

  /** One entry per achievement chain: its first unclaimed tier (the last one once everything is claimed). */
  private achievementList(achievements: ObjectiveDefinition[], dto: (o: ObjectiveDefinition) => ObjectiveDto): ObjectiveDto[] {
    const chains = new Map<string, ObjectiveDefinition[]>();
    for (const objective of achievements) {
      const key = objective.group || objective.id;
      chains.set(key, [...(chains.get(key) ?? []), objective]);
    }
    const list: ObjectiveDto[] = [];
    for (const chain of chains.values()) {
      chain.sort((a, b) => a.tier - b.tier);
      const tiers = chain.map(dto);
      const current = tiers.find((t) => !t.claimed) ?? tiers[tiers.length - 1];
      list.push({ ...current, tiers: chain.length, tier: chain.findIndex((o) => o.id === current.id) + 1 });
    }
    return list;
  }

  private toDto(objective: ObjectiveDefinition, row: ObjectiveProgressRow | undefined, lang?: string): ObjectiveDto {
    const progress = Math.min(row?.progress ?? 0, objective.target);
    return {
      id: objective.id,
      kind: objective.kind,
      title: localize(objective.title, lang),
      description: localize(objective.description, lang),
      metric: objective.metric,
      target: objective.target,
      progress,
      completed: progress >= objective.target,
      claimed: !!row?.claimedAt,
      reward: objective.reward,
      tier: objective.tier,
      tiers: 1,
    };
  }
}

function unix(ms: number): number {
  return Math.floor(ms / 1000);
}

export function addReward(total: RewardBundle, add: RewardBundle): void {
  const currencies = total.currencies as Record<string, number>;
  for (const [id, amount] of Object.entries(add.currencies)) currencies[id] = (currencies[id] ?? 0) + amount;
  for (const [id, amount] of Object.entries(add.items)) total.items[id] = (total.items[id] ?? 0) + amount;
  total.exp += add.exp;
}
