// Event tower use cases. A tower is a timed list of floors climbed in order; every floor is an
// authoritative battle (mode "tower", target "towerId:floor", floors are 1-based). The first victory on the next floor
// raises the player's progress and grants the floor's reward (ledger reason TOWER_REWARD) in the battle's result
// transaction; replaying a cleared floor is allowed and grants nothing.

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import { normalizeLanguage } from "../../shared/content/localized-text.js";
import { localize } from "../../shared/localized.js";
import type { BattleMode, ModeBattle, ModeSettlement, PreparedBattle } from "../battle/battle-modes.js";
import type { BattleOutcome } from "../battle/battle-rules.js";
import type { BattleCatalog } from "../battle/content/battle-content.js";
import type { RewardBundle } from "../economy/reward-granter.js";
import type { TowerDefinition } from "./tower-content.js";
import type { TowerRepository } from "./tower.repository.js";

export const TOWER_MODE = "tower";
const DAY_MS = 86_400_000;
/** Towers that ended stay in the answer this long, so the player can see how far they got. */
export const ENDED_VISIBLE_MS = 2 * DAY_MS;

export type TowerFloorDto = {
  floor: number;
  /** Localized floor name; empty = the client shows "Floor N". */
  title: string;
  reward: RewardBundle;
  cleared: boolean;
  /** The next floor to clear. */
  current: boolean;
  locked: boolean;
};

export type TowerDto = {
  id: string;
  title: string;
  description: string;
  banner: string;
  startsAtUnix: number;
  endsAtUnix: number;
  running: boolean;
  highestCleared: number;
  floors: TowerFloorDto[];
};

export type TowerInfoDto = { towers: TowerDto[] };

/** What a tower battle adds to its result (`tower` in the battle result). */
export type TowerResultDto = { towerId: string; floor: number; floors: number; cleared: boolean; highestCleared: number };

export class TowerService {
  readonly mode: BattleMode;

  constructor(
    private readonly catalog: BattleCatalog,
    private readonly progress: TowerRepository,
    private readonly clock: Clock,
  ) {
    this.mode = new TowerMode(this);
  }

  /** Running towers plus the ones that ended in the last two days, with the player's progress. */
  async info(userId: string, lang?: string): Promise<TowerInfoDto> {
    const now = this.clock.nowMs();
    const visible = (this.catalog.towers?.towers ?? [])
      .filter((tower) => now >= tower.startsAtMs && now < tower.endsAtMs + ENDED_VISIBLE_MS)
      .sort((a, b) => a.startsAtMs - b.startsAtMs || a.id.localeCompare(b.id));
    const highest = await this.progress.highestCleared(userId, visible.map((tower) => tower.id));
    return { towers: visible.map((tower) => this.toDto(tower, highest.get(tower.id) ?? 0, now, lang)) };
  }

  /** Checks a player may play `floor` of the tower now and returns the battle it runs. */
  async startFloor(userId: string, target: string, lang?: string): Promise<ModeBattle> {
    const { towerId, floor } = parseTarget(target);
    const tower = this.catalog.towers?.get(towerId);
    if (!tower || floor < 1 || floor > tower.floors.length) throw new AppError(ErrorCode.TOWER_UNKNOWN);
    if (!tower.isRunning(this.clock.nowMs())) throw new AppError(ErrorCode.TOWER_NOT_RUNNING);
    const highest = (await this.progress.highestCleared(userId, [towerId])).get(towerId) ?? 0;
    if (floor > highest + 1) throw new AppError(ErrorCode.TOWER_FLOOR_LOCKED, { extra: { nextFloor: highest + 1 } });
    const definition = tower.floors[floor - 1];
    const floorLabel = {
      en: `Floor ${floor}`, pt: `Andar ${floor}`, es: `Piso ${floor}`, zh: `第${floor}层`, ja: `${floor}階`, ko: `${floor}층`,
    }[normalizeLanguage(lang)];
    const title = `${localize(tower.title, lang)} - ${floorLabel}`;
    return {
      stage: this.catalog.modeStage(stageId(towerId, floor), title, definition.encounter, definition.difficulty, definition.threeStarSeconds),
      context: { towerId, floor },
      info: { tower: { towerId, floor, floors: tower.floors.length } },
    };
  }

  /** Counts a finished tower battle (inside the battle's result transaction). */
  async settle(session: DbSession, userId: string, towerId: string, floor: number, outcome: BattleOutcome): Promise<{ reward: RewardBundle; result: TowerResultDto }> {
    const tower = this.catalog.towers?.get(towerId);
    if (!tower) throw new AppError(ErrorCode.TOWER_UNKNOWN);
    const highest = await this.progress.lockProgress(userId, towerId, session);
    const cleared = outcome.kind === "VICTORY" && floor === highest + 1;
    if (cleared) await this.progress.save(userId, towerId, floor, session);
    return {
      reward: cleared ? tower.floors[floor - 1].reward : { currencies: {}, items: {}, exp: 0 },
      result: { towerId, floor, floors: tower.floors.length, cleared, highestCleared: cleared ? floor : highest },
    };
  }

  private toDto(tower: TowerDefinition, highest: number, now: number, lang?: string): TowerDto {
    return {
      id: tower.id,
      title: localize(tower.title, lang),
      description: localize(tower.description, lang),
      banner: tower.banner,
      startsAtUnix: Math.floor(tower.startsAtMs / 1000),
      endsAtUnix: Math.floor(tower.endsAtMs / 1000),
      running: tower.isRunning(now),
      highestCleared: highest,
      floors: tower.floors.map((floor, index) => {
        const number = index + 1;
        return {
          floor: number,
          title: floor.title === undefined ? "" : localize(floor.title, lang),
          reward: floor.reward,
          cleared: number <= highest,
          current: number === highest + 1,
          locked: number > highest + 1,
        };
      }),
    };
  }
}

export function stageId(towerId: string, floor: number): string {
  return `tower:${towerId}:${floor}`;
}

/** "towerId:floor" (floor 1-based). */
function parseTarget(target: string): { towerId: string; floor: number } {
  const cut = target.lastIndexOf(":");
  const floorText = cut < 0 ? "" : target.slice(cut + 1);
  if (cut < 1 || !/^[0-9]{1,3}$/.test(floorText)) throw new AppError(ErrorCode.TOWER_UNKNOWN);
  return { towerId: target.slice(0, cut), floor: Number(floorText) };
}

/** Event towers as a battle mode: target "towerId:floor". */
class TowerMode implements BattleMode {
  readonly id = TOWER_MODE;

  constructor(private readonly service: TowerService) {}

  prepare(userId: string, target: string, _playerLevel: number, lang?: string): Promise<ModeBattle> {
    return this.service.startFloor(userId, target, lang);
  }

  async settle(session: DbSession, battle: PreparedBattle, outcome: BattleOutcome): Promise<ModeSettlement> {
    const { towerId, floor } = battle.context as { towerId: string; floor: number };
    const { reward, result } = await this.service.settle(session, battle.userId, towerId, floor, outcome);
    return {
      stars: 0, bestStars: 0, firstClear: result.cleared, reward, reason: "TOWER_REWARD", stageCleared: false, extra: result,
    };
  }
}
