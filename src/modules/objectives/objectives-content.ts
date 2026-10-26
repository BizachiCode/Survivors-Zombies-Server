// Progression content (exported from Unity with the battle content): objectives counted from what players do — daily
// and weekly missions, achievements (tiered chains), and event objectives that only count while their event runs — and
// the daily login calendar.

import { z } from "zod";

import { BattleContentError } from "../battle/sim/definitions.js";
import { RewardBundleSchema, unknownRewardItems } from "../economy/reward-granter.js";
import { LocalizedTextSchema } from "../../shared/localized.js";

const int = z.number().int();
const id = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

/** What objectives count. Gameplay features report them inside their transactions (ObjectiveService.record). */
export const METRICS = [
  "battles_played", "battles_won", "stars_earned", "stages_cleared", "enemies_killed", "defenders_placed", "merges",
  "cards_upgraded", "cards_unlocked", "shop_purchases", "coins_spent", "gems_spent", "daily_rewards_claimed",
] as const;
export type Metric = (typeof METRICS)[number];
export type MetricAmounts = Partial<Record<Metric, number>>;

export const OBJECTIVE_KINDS = ["daily", "weekly", "achievement", "event"] as const;
export type ObjectiveKind = (typeof OBJECTIVE_KINDS)[number];

export const ObjectiveSchema = z.strictObject({
  id,
  kind: z.enum(OBJECTIVE_KINDS),
  title: LocalizedTextSchema,
  description: LocalizedTextSchema.default(""),
  metric: z.enum(METRICS),
  target: int.min(1).max(1_000_000_000),
  reward: RewardBundleSchema,
  /** kind "event": the event it belongs to. */
  event: z.string().max(64).default(""),
  /** Achievements: chain id (tiers of the same goal); the list shows the first unclaimed tier. */
  group: z.string().max(64).default(""),
  tier: int.min(1).max(100).default(1),
  /** Hidden below this player level. */
  requiredLevel: int.min(0).max(1000).default(0),
});

export const EventSchema = z.strictObject({
  id,
  title: LocalizedTextSchema,
  description: LocalizedTextSchema.default(""),
  /** Art key the client maps to a banner. */
  banner: z.string().max(64).default(""),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
});

export const ProgressionSchema = z.strictObject({
  objectives: z.array(ObjectiveSchema).max(500).default([]),
  events: z.array(EventSchema).max(50).default([]),
  /** Login calendar: one reward per day claimed, looping. Empty = no daily rewards. */
  dailyRewards: z.array(RewardBundleSchema).max(31).default([]),
});

export type ObjectiveDefinition = z.infer<typeof ObjectiveSchema>;
export type EventDefinition = z.infer<typeof EventSchema>;
export type ProgressionContent = z.infer<typeof ProgressionSchema>;

/** Validated progression content with its time windows. */
export class ProgressionCatalog {
  readonly objectives: readonly ObjectiveDefinition[];
  readonly events: readonly EventDefinition[];
  readonly dailyRewards: ProgressionContent["dailyRewards"];
  private readonly byId = new Map<string, ObjectiveDefinition>();
  private readonly eventById = new Map<string, EventDefinition>();

  constructor(content: ProgressionContent, refs: { knownItem: (itemId: string) => boolean }) {
    this.objectives = Object.freeze([...content.objectives]);
    this.events = Object.freeze([...content.events]);
    this.dailyRewards = content.dailyRewards;
    for (const event of content.events) {
      if (this.eventById.has(event.id)) throw new BattleContentError(`Duplicate event id: ${event.id}.`);
      if (Date.parse(event.endsAt) <= Date.parse(event.startsAt)) throw new BattleContentError(`Event ${event.id} ends before it starts.`);
      this.eventById.set(event.id, event);
    }
    for (const objective of content.objectives) {
      if (this.byId.has(objective.id)) throw new BattleContentError(`Duplicate objective id: ${objective.id}.`);
      if (objective.kind === "event" && !this.eventById.has(objective.event)) {
        throw new BattleContentError(`Objective ${objective.id}: unknown event "${objective.event}".`);
      }
      const unknown = unknownRewardItems(objective.reward, refs.knownItem);
      if (unknown.length > 0) throw new BattleContentError(`Objective ${objective.id}: unknown reward item ${unknown[0]}.`);
      this.byId.set(objective.id, objective);
    }
    content.dailyRewards.forEach((reward, index) => {
      const unknown = unknownRewardItems(reward, refs.knownItem);
      if (unknown.length > 0) throw new BattleContentError(`Daily reward ${index + 1}: unknown item ${unknown[0]}.`);
    });
  }

  objective(objectiveId: string): ObjectiveDefinition | undefined {
    return this.byId.get(objectiveId);
  }

  event(eventId: string): EventDefinition | undefined {
    return this.eventById.get(eventId);
  }

  /** True while an event runs. */
  isRunning(event: EventDefinition, nowMs: number): boolean {
    return Date.parse(event.startsAt) <= nowMs && nowMs < Date.parse(event.endsAt);
  }
}

// ---------------------------------------------------------------------- periods (UTC)
const DAY_MS = 86_400_000;

export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Monday 00:00 UTC of the week of `ms`. */
export function weekStartMs(ms: number): number {
  const day = Math.floor(ms / DAY_MS) * DAY_MS;
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  return day - weekday * DAY_MS;
}

/** Progress bucket of an objective at `ms`: the day, the week, the event, or forever (achievements). */
export function periodOf(objective: ObjectiveDefinition, ms: number): string {
  switch (objective.kind) {
    case "daily": return `D:${dayKey(ms)}`;
    case "weekly": return `W:${dayKey(weekStartMs(ms))}`;
    case "event": return `E:${objective.event}`;
    case "achievement": return "A";
  }
}

export function nextDayMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS + DAY_MS;
}

export function nextWeekMs(ms: number): number {
  return weekStartMs(ms) + 7 * DAY_MS;
}
