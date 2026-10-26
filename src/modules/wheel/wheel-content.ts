// Lucky wheel content (exported from Unity inside the battle content as the optional `wheel` block): the segments with
// their weights and rewards, the free spins per day, the price of an extra spin and the daily limit.

import { z } from "zod";

import { CURRENCY_IDS } from "../../config/game-config.js";
import { BattleContentError } from "../battle/sim/definitions.js";
import { RewardBundleSchema, isEmptyReward, unknownRewardItems } from "../economy/reward-granter.js";

const int = z.number().int();
const id = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

export const WheelSegmentSchema = z.strictObject({
  id,
  /** Relative chance of the segment (a segment with weight 3 comes up three times as often as one with weight 1). */
  weight: int.min(1).max(1_000_000),
  reward: RewardBundleSchema,
});

export const WheelSchema = z.strictObject({
  segments: z.array(WheelSegmentSchema).min(2).max(12),
  /** Spins every player gets for free each UTC day. */
  freeSpinsPerDay: int.min(0).max(100).default(1),
  /** Price of a spin beyond the free ones; amount 0 = spins cannot be bought. */
  spinCost: z.strictObject({
    currency: z.enum(CURRENCY_IDS).default("gems"),
    amount: int.min(0).max(1_000_000_000).default(0),
  }).default({ currency: "gems", amount: 0 }),
  /** Total spins (free + bought) per UTC day; 0 = unlimited. */
  dailyLimit: int.min(0).max(10_000).default(0),
});

export type WheelSegment = z.infer<typeof WheelSegmentSchema>;
export type WheelContent = z.infer<typeof WheelSchema>;

/** Validated wheel content. */
export class WheelCatalog {
  readonly segments: readonly WheelSegment[];
  readonly freeSpinsPerDay: number;
  readonly spinCost: WheelContent["spinCost"];
  readonly dailyLimit: number;
  readonly totalWeight: number;

  constructor(content: WheelContent, refs: { knownItem: (itemId: string) => boolean }) {
    const seen = new Set<string>();
    for (const segment of content.segments) {
      if (seen.has(segment.id)) throw new BattleContentError(`Duplicate wheel segment id: ${segment.id}.`);
      seen.add(segment.id);
      if (isEmptyReward(segment.reward)) throw new BattleContentError(`Wheel segment ${segment.id}: empty reward.`);
      const unknown = unknownRewardItems(segment.reward, refs.knownItem);
      if (unknown.length > 0) throw new BattleContentError(`Wheel segment ${segment.id}: unknown reward item ${unknown[0]}.`);
    }
    this.segments = Object.freeze([...content.segments]);
    this.freeSpinsPerDay = content.freeSpinsPerDay;
    this.spinCost = content.spinCost;
    this.dailyLimit = content.dailyLimit;
    this.totalWeight = content.segments.reduce((sum, segment) => sum + segment.weight, 0);
  }

  /** Index of the segment for a uniform integer `roll` in [0, totalWeight). */
  segmentAt(roll: number): number {
    let rest = roll;
    for (let index = 0; index < this.segments.length; index++) {
      rest -= this.segments[index].weight;
      if (rest < 0) return index;
    }
    return this.segments.length - 1;
  }
}
