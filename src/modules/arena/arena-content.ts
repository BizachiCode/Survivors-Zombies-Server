// Arena content (exported from Unity with the battle content): the weekly arena battle (an encounter played for score),
// how the score is counted, tickets, the size of the groups players compete in, and the leagues with their promotion /
// demotion places and end-of-season rewards.

import { z } from "zod";

import { CURRENCY_IDS } from "../../config/game-config.js";
import { LocalizedTextSchema, type LocalizedText } from "../../shared/localized.js";
import { BattleContentError } from "../battle/sim/definitions.js";
import { isEmptyReward, RewardBundleSchema, unknownRewardItems, type RewardBundle } from "../economy/reward-granter.js";

const int = z.number().int();
const id = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const DAY_MS = 86_400_000;

export const ArenaLeagueSchema = z.strictObject({
  id,
  name: LocalizedTextSchema,
  /** Best ranks of a group that move up a league at the end of the season (0 in the top league). */
  promote: int.min(0).max(100),
  /** Worst ranks of a group that move down a league (0 in the first league). */
  demote: int.min(0).max(100),
  /** End-of-season rewards by rank: each tier covers the ranks up to `toRank` (ascending). */
  rewards: z.array(z.strictObject({ toRank: int.min(1).max(1000), reward: RewardBundleSchema })).max(20).default([]),
});

export const ArenaSchema = z.strictObject({
  title: LocalizedTextSchema,
  encounter: id,
  difficulty: id,
  /** score = kills × perKill + waves reached × perWave + (victory ? victoryBonus + base health left × perBaseHealth : 0). */
  scoring: z.strictObject({
    perKill: int.min(0).max(100_000),
    perWave: int.min(0).max(100_000),
    victoryBonus: int.min(0).max(10_000_000),
    perBaseHealth: int.min(0).max(100_000),
  }),
  tickets: z.strictObject({
    max: int.min(1).max(100),
    /** One ticket comes back every `regenMinutes` up to `max`. */
    regenMinutes: int.min(1).max(10_080),
    /** Price of one extra ticket; amount 0 = tickets can't be bought. */
    price: z.strictObject({ currency: z.enum(CURRENCY_IDS), amount: int.min(0).max(1_000_000) }),
  }),
  /** Players per group; a league is split into groups of this size as players join during the week. */
  groupSize: int.min(2).max(200),
  leagues: z.array(ArenaLeagueSchema).min(1).max(20),
});

export type ArenaContent = z.infer<typeof ArenaSchema>;
export type ArenaLeague = z.infer<typeof ArenaLeagueSchema> & { rewards: { toRank: number; reward: RewardBundle }[] };
export type ArenaScoring = ArenaContent["scoring"];

/** What the arena counts from a finished battle. */
export type ArenaRun = { victory: boolean; kills: number; waves: number; baseHealth: number };

export function arenaScore(scoring: ArenaScoring, run: ArenaRun): number {
  let score = run.kills * scoring.perKill + run.waves * scoring.perWave;
  if (run.victory) score += scoring.victoryBonus + run.baseHealth * scoring.perBaseHealth;
  return Math.max(0, Math.round(score));
}

/** Seasons run Monday 00:00 UTC → next Monday; a season id is its Monday (YYYY-MM-DD). */
export function seasonOf(nowMs: number): { id: string; startsAtMs: number; endsAtMs: number } {
  const day = Math.floor(nowMs / DAY_MS);
  // 1970-01-01 was a Thursday: day 4 is the first Monday.
  const monday = day - ((day - 4) % 7 + 7) % 7;
  const startsAtMs = monday * DAY_MS;
  return { id: new Date(startsAtMs).toISOString().slice(0, 10), startsAtMs, endsAtMs: startsAtMs + 7 * DAY_MS };
}

/** Validated arena content. */
export class ArenaCatalog {
  readonly title: LocalizedText;
  readonly encounter: string;
  readonly difficulty: string;
  readonly scoring: ArenaScoring;
  readonly tickets: ArenaContent["tickets"];
  readonly groupSize: number;
  readonly leagues: readonly ArenaLeague[];

  constructor(content: ArenaContent, refs: { knownItem: (itemId: string) => boolean; hasEncounter: (id: string) => boolean; hasDifficulty: (id: string) => boolean }) {
    if (!refs.hasEncounter(content.encounter)) throw new BattleContentError(`Arena: unknown encounter ${content.encounter}.`);
    if (!refs.hasDifficulty(content.difficulty)) throw new BattleContentError(`Arena: unknown difficulty ${content.difficulty}.`);
    const ids = new Set<string>();
    for (const league of content.leagues) {
      if (ids.has(league.id)) throw new BattleContentError(`Arena: duplicate league ${league.id}.`);
      ids.add(league.id);
      if (league.promote + league.demote > content.groupSize) throw new BattleContentError(`Arena league ${league.id}: promote + demote exceed the group size.`);
      let previous = 0;
      for (const tier of league.rewards) {
        if (tier.toRank <= previous) throw new BattleContentError(`Arena league ${league.id}: reward ranks must grow.`);
        previous = tier.toRank;
        if (isEmptyReward(tier.reward as RewardBundle)) throw new BattleContentError(`Arena league ${league.id}: an empty reward.`);
        const unknown = unknownRewardItems(tier.reward as RewardBundle, refs.knownItem);
        if (unknown.length > 0) throw new BattleContentError(`Arena league ${league.id}: unknown item ${unknown[0]}.`);
      }
    }
    this.title = content.title;
    this.encounter = content.encounter;
    this.difficulty = content.difficulty;
    this.scoring = content.scoring;
    this.tickets = content.tickets;
    this.groupSize = content.groupSize;
    this.leagues = Object.freeze([...(content.leagues as ArenaLeague[])]);
  }

  league(index: number): ArenaLeague {
    return this.leagues[Math.min(Math.max(0, index), this.leagues.length - 1)];
  }

  /** The end-of-season reward of a rank in a league (null beyond the last tier). */
  rewardFor(leagueIndex: number, rank: number): RewardBundle | null {
    const tier = this.league(leagueIndex).rewards.find((t) => rank <= t.toRank);
    return tier ? tier.reward : null;
  }
}
