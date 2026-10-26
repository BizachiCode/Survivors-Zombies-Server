// Campaign rules decided by the server: unlocking, stars and the reward of a finished battle. The Unity Offline backend
// mirrors them (Core/Backend/Offline), so keep both sides in sync.

import { CURRENCY_IDS } from "../../config/game-config.js";
import type { Reward, StageDefinition } from "./content/battle-content.js";

export const BATTLE_OUTCOMES = ["VICTORY", "DEFEAT", "ABANDONED"] as const;
export type BattleOutcomeKind = (typeof BATTLE_OUTCOMES)[number];

/** How a battle ended, as measured by the server's simulation. */
export type BattleOutcome = {
  kind: BattleOutcomeKind;
  /** Battle time (ticks × tick seconds; pauses and speed do not count). */
  seconds: number;
  ticks: number;
  baseHealth: number;
  maxBaseHealth: number;
  kills: number;
  /** Waves that had started when the battle ended (score modes). */
  waves?: number;
  /** Defenders placed and merged (in-battle level ups); counted by objectives. */
  placed?: number;
  merges?: number;
};

/** A stage opens at its required level once every prerequisite has been won (at least one star). */
export function isUnlocked(stage: StageDefinition, level: number, bestStarsOf: (stageId: string) => number): boolean {
  if (level < stage.requiredLevel) return false;
  return stage.prerequisites.every((id) => bestStarsOf(id) > 0);
}

/** Victory: one star, plus one for an untouched base, plus one for a win within the stage's time. Otherwise 0. */
export function starsFor(stage: StageDefinition, outcome: BattleOutcome): number {
  if (outcome.kind !== "VICTORY") return 0;
  return 1 + (outcome.baseHealth === outcome.maxBaseHealth ? 1 : 0) + (outcome.seconds <= stage.threeStarSeconds ? 1 : 0);
}

/** Victory reward (+ first clear bonus), the defeat reward, or nothing for an abandoned battle. */
export function rewardFor(stage: StageDefinition, outcome: BattleOutcome, firstClear: boolean): Reward {
  if (outcome.kind === "ABANDONED") return emptyReward();
  if (outcome.kind === "DEFEAT") return addRewards(emptyReward(), stage.defeatReward);
  const reward = addRewards(emptyReward(), stage.victoryReward);
  return firstClear ? addRewards(reward, stage.firstClearBonus) : reward;
}

export function emptyReward(): Reward {
  return { currencies: {}, items: {}, exp: 0 };
}

export function addRewards(a: Reward, b: Reward): Reward {
  const currencies: Reward["currencies"] = { ...a.currencies };
  for (const currencyId of CURRENCY_IDS) {
    const amount = (currencies[currencyId] ?? 0) + (b.currencies[currencyId] ?? 0);
    if (amount > 0) currencies[currencyId] = amount;
  }
  const items: Reward["items"] = { ...a.items };
  for (const [itemId, amount] of Object.entries(b.items ?? {})) items[itemId] = (items[itemId] ?? 0) + amount;
  return { currencies, items, exp: a.exp + b.exp };
}
