// Battle modes: every authoritative battle runs in the same `battle` room, and a mode decides what it is for. The
// campaign is one mode; features such as the arena or event towers register their own (BattleService.registerMode).
// A mode says whether the player may play a target and which stage-like definition runs, then settles the result
// inside the transaction that records the battle (its progress and the reward to grant).

import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { LedgerReason } from "../economy/wallet-ledger.js";
import type { ItemLedgerReason } from "../collection/inventory-ledger.js";
import type { BattleOutcome } from "./battle-rules.js";
import type { Reward, StageDefinition } from "./content/battle-content.js";
import type { BattleSpec } from "./sim/battle-spec.js";

export const CAMPAIGN_MODE = "campaign";

/** What a mode decides when a battle starts. */
export type ModeBattle = {
  /** What the battle runs: encounter, difficulty, title, three-star time (its id is recorded with the result). */
  stage: StageDefinition;
  /** Data the mode needs again when the battle ends (a season, a floor...). Never sent to the client. */
  context?: Record<string, unknown>;
  /** Fields added to the `start` answer (rules the client shows, e.g. how the score is counted). */
  info?: Record<string, unknown>;
};

/** What a mode decides when a battle ends. */
export type ModeSettlement = {
  stars: number;
  bestStars: number;
  firstClear: boolean;
  reward: Reward;
  /** Ledger reason of the reward (default STAGE_REWARD). */
  reason?: LedgerReason & ItemLedgerReason;
  /** Counts for the "stages cleared" objectives. */
  stageCleared?: boolean;
  /** Mode-specific result, sent to the client under the mode's id (e.g. `arena: { score, rank }`). */
  extra?: Record<string, unknown>;
};

/** A battle the server agreed to run for a player. */
export type PreparedBattle = {
  battleId: string;
  userId: string;
  mode: string;
  target: string;
  stage: StageDefinition;
  spec: BattleSpec;
  context: Record<string, unknown>;
  info: Record<string, unknown>;
};

export interface BattleMode {
  readonly id: string;
  /**
   * Throws an AppError when the player may not play `target` now (unknown, locked, no tickets...). `lang` is the
   * player's language for texts such as the battle title.
   */
  prepare(userId: string, target: string, playerLevel: number, lang?: string): Promise<ModeBattle>;
  /** Inside the result transaction (the result row is already written, so this runs once per battle). */
  settle(session: DbSession, battle: PreparedBattle, outcome: BattleOutcome): Promise<ModeSettlement>;
}
