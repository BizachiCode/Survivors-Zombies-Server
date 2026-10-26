// Campaign and battle use cases: the stage list with the player's progress, starting a battle of any mode (the mode's
// checks, the resolved spec) and recording its end (the mode's progress, rewards through the ledgers, experience,
// objectives) exactly once.

import { randomUUID } from "node:crypto";
import { localize } from "../../shared/localized.js";

import { AppError } from "../../shared/errors/app-error.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { WalletDto, WalletLedger } from "../economy/wallet-ledger.js";
import { applyExperience } from "../profile/experience.js";
import { NO_RECORDER, type ObjectiveRecorder } from "../objectives/objectives.service.js";
import type { ProfileDto } from "../profile/profile.dto.js";
import { toProfileDto } from "../profile/profile.mapper.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import type { CollectionService } from "../collection/collection.service.js";
import type { InventoryLedger, ItemAmounts } from "../collection/inventory-ledger.js";
import { CAMPAIGN_MODE, type BattleMode, type ModeBattle, type ModeSettlement, type PreparedBattle } from "./battle-modes.js";
import type { BattleRepository, StageProgressRow } from "./battle.repository.js";
import { isUnlocked, rewardFor, starsFor, type BattleOutcome, type BattleOutcomeKind } from "./battle-rules.js";
import type { BattleCatalog, Reward } from "./content/battle-content.js";

export type { PreparedBattle } from "./battle-modes.js";

export type StageDto = {
  id: string;
  title: string;
  /** World map location (map node id). */
  location: string;
  requiredLevel: number;
  prerequisites: string[];
  unlocked: boolean;
  stars: number;
  wins: number;
};

export type CampaignDto = { stages: StageDto[] };

export type BattleResultDto = {
  battleId: string;
  mode: string;
  target: string;
  stageId: string;
  outcome: BattleOutcomeKind;
  stars: number;
  bestStars: number;
  firstClear: boolean;
  seconds: number;
  reward: Reward;
  levelsGained: number;
  /** Cards this result unlocked (stage clears, player levels). */
  unlockedCards: string[];
  profile: ProfileDto;
  wallet: WalletDto;
  items: ItemAmounts;
  /** Mode-specific results under the mode's id (e.g. `arena`). */
  [mode: string]: unknown;
};

export class BattleService {
  private readonly modes = new Map<string, BattleMode>();

  constructor(
    private readonly catalog: BattleCatalog,
    private readonly battles: BattleRepository,
    private readonly profiles: ProfileRepository,
    private readonly wallets: WalletLedger,
    private readonly uow: UnitOfWork,
    private readonly inventory: InventoryLedger,
    /** Null when the content has no card collection. */
    private readonly collection: CollectionService | null = null,
    private readonly recorder: ObjectiveRecorder = NO_RECORDER,
  ) {
    this.registerMode(new CampaignMode(catalog, battles));
  }

  /** Adds a battle mode (arena, event tower...). Its id is what clients put in the battle's join options. */
  registerMode(mode: BattleMode): void {
    if (this.modes.has(mode.id)) throw new Error(`Battle mode ${mode.id} is already registered.`);
    this.modes.set(mode.id, mode);
  }

  /** Every stage with the player's stars and whether it can be played. */
  async campaign(userId: string, lang?: string): Promise<CampaignDto> {
    const profile = await this.profiles.getProfile(userId);
    if (!profile) throw new AppError(ErrorCode.UNAUTHORIZED);
    const progress = indexProgress(await this.battles.listProgress(userId));
    return {
      stages: this.catalog.stages.map((stage) => ({
        id: stage.id,
        title: localize(stage.title, lang),
        location: stage.location,
        requiredLevel: stage.requiredLevel,
        prerequisites: [...stage.prerequisites],
        unlocked: isUnlocked(stage, profile.level, (id) => progress.get(id)?.bestStars ?? 0),
        stars: progress.get(stage.id)?.bestStars ?? 0,
        wins: progress.get(stage.id)?.wins ?? 0,
      })),
    };
  }

  /** A campaign battle of `stageId` (see {@link prepareMode}). */
  prepare(userId: string, stageId: string): Promise<PreparedBattle> {
    return this.prepareMode(userId, CAMPAIGN_MODE, stageId);
  }

  /** Asks the mode whether `target` may be played now, then resolves the battle it runs. */
  async prepareMode(userId: string, modeId: string, target: string, lang?: string): Promise<PreparedBattle> {
    const mode = this.modes.get(modeId);
    if (!mode) throw new AppError(ErrorCode.BATTLE_MODE_UNKNOWN);
    const profile = await this.profiles.getProfile(userId);
    if (!profile) throw new AppError(ErrorCode.UNAUTHORIZED);
    const chosen: ModeBattle = await mode.prepare(userId, target, profile.level, lang);
    // With a collection, "player" encounters run with the player's team at its collection levels.
    const team = this.catalog.usesTeam(chosen.stage) && this.collection ? await this.collection.team(userId) : undefined;
    return {
      battleId: randomUUID(),
      userId,
      mode: modeId,
      target,
      stage: chosen.stage,
      spec: this.catalog.resolve(chosen.stage, { team }),
      context: chosen.context ?? {},
      info: chosen.info ?? {},
    };
  }

  /**
   * Records how a battle ended, once: the result row, the mode's progress and reward (currencies and items through the
   * ledgers, experience with level ups) and the objectives, in one transaction. A battle id that was already recorded
   * throws BATTLE_ALREADY_FINISHED and grants nothing.
   */
  async finish(battle: PreparedBattle, outcome: BattleOutcome, contentHash: string): Promise<BattleResultDto> {
    const { stage, userId, battleId } = battle;
    const mode = this.modes.get(battle.mode);
    if (!mode) throw new AppError(ErrorCode.BATTLE_MODE_UNKNOWN);
    const result = await this.uow.transaction(async (session) => {
      const profile = await this.profiles.getProfile(userId, session, true);
      if (!profile) throw new AppError(ErrorCode.UNAUTHORIZED);
      try {
        await this.battles.insertResult({
          id: battleId, userId, mode: battle.mode, stageId: stage.id, outcome: outcome.kind, stars: 0, ticks: outcome.ticks, kills: outcome.kills,
          baseHealth: outcome.baseHealth, contentHash, reward: { currencies: {}, items: {}, exp: 0 },
        }, session);
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new AppError(ErrorCode.BATTLE_ALREADY_FINISHED);
        throw error;
      }

      const settled: ModeSettlement = await mode.settle(session, battle, outcome);
      const { reward, stars } = settled;
      await this.battles.updateResult(battleId, stars, reward, session);
      const reason = settled.reason ?? "STAGE_REWARD";
      if (Object.keys(reward.currencies).length > 0) await this.wallets.credit(session, userId, reward.currencies, reason);
      await this.inventory.credit(session, userId, reward.items, reason);
      let levelsGained = 0;
      if (reward.exp > 0) {
        const levelled = applyExperience(profile.level, profile.exp, reward.exp);
        levelsGained = levelled.levelsGained;
        await this.profiles.updateLevel(userId, levelled.level, levelled.exp, session);
      }
      // Cards granted by this stage clear or the new player level.
      const unlockedCards = this.collection ? await this.collection.grant(session, userId) : [];
      if (outcome.kind !== "ABANDONED") {
        const victory = outcome.kind === "VICTORY";
        await this.recorder.record(session, userId, {
          battles_played: 1, battles_won: victory ? 1 : 0, stars_earned: stars, stages_cleared: settled.stageCleared ? 1 : 0,
          enemies_killed: outcome.kills, defenders_placed: outcome.placed ?? 0, merges: outcome.merges ?? 0,
        });
      }
      return { settled, levelsGained, unlockedCards };
    });

    const profile = await this.profiles.getProfile(userId);
    const { settled } = result;
    return {
      battleId,
      mode: battle.mode,
      target: battle.target,
      stageId: stage.id,
      outcome: outcome.kind,
      seconds: outcome.seconds,
      stars: settled.stars,
      bestStars: settled.bestStars,
      firstClear: settled.firstClear,
      reward: settled.reward,
      levelsGained: result.levelsGained,
      unlockedCards: result.unlockedCards,
      ...(settled.extra ? { [battle.mode]: settled.extra } : {}),
      profile: toProfileDto(profile),
      wallet: await this.wallets.snapshot(userId),
      items: await this.inventory.snapshot(userId),
    };
  }
}

/** The campaign: stages unlocked by level and prerequisites, stars, first clear bonus, stage progress. */
class CampaignMode implements BattleMode {
  readonly id = CAMPAIGN_MODE;

  constructor(
    private readonly catalog: BattleCatalog,
    private readonly battles: BattleRepository,
  ) {}

  async prepare(userId: string, stageId: string, playerLevel: number, lang?: string): Promise<ModeBattle> {
    const stage = this.catalog.stage(stageId);
    if (!stage) throw new AppError(ErrorCode.STAGE_UNKNOWN);
    const progress = indexProgress(await this.battles.listProgress(userId));
    if (!isUnlocked(stage, playerLevel, (id) => progress.get(id)?.bestStars ?? 0)) {
      throw new AppError(ErrorCode.STAGE_LOCKED, { extra: { requiredLevel: stage.requiredLevel, prerequisites: [...stage.prerequisites] } });
    }
    // The battle screen shows the title in the player's language.
    return { stage: { ...stage, title: localize(stage.title, lang) }, info: { threeStarSeconds: stage.threeStarSeconds } };
  }

  async settle(session: DbSession, battle: PreparedBattle, outcome: BattleOutcome): Promise<ModeSettlement> {
    const { stage, userId } = battle;
    const progress = await this.battles.getProgress(userId, stage.id, session, true);
    const victory = outcome.kind === "VICTORY";
    const firstClear = victory && (progress?.wins ?? 0) === 0;
    const stars = starsFor(stage, outcome);
    const timeMs = Math.round(outcome.seconds * 1000);
    const next: StageProgressRow = {
      userId,
      stageId: stage.id,
      bestStars: Math.max(progress?.bestStars ?? 0, stars),
      wins: (progress?.wins ?? 0) + (victory ? 1 : 0),
      plays: (progress?.plays ?? 0) + 1,
      bestTimeMs: victory ? Math.min(progress?.bestTimeMs ?? timeMs, timeMs) : progress?.bestTimeMs ?? null,
      firstClearedAt: progress?.firstClearedAt ?? (victory ? new Date() : null),
    };
    await this.battles.saveProgress(next, session);
    return { stars, bestStars: next.bestStars, firstClear, reward: rewardFor(stage, outcome, firstClear), stageCleared: firstClear };
  }
}

function indexProgress(rows: StageProgressRow[]): Map<string, StageProgressRow> {
  return new Map(rows.map((row) => [row.stageId, row]));
}
