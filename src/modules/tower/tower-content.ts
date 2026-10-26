// Event tower content (exported from Unity with the battle content): timed towers of floors.
// Each floor is an encounter with a difficulty and a reward granted the first time the floor is cleared; floors are
// climbed in order. A tower is playable between `startsAt` and `endsAt`.

import { z } from "zod";

import { LocalizedTextSchema, type LocalizedText } from "../../shared/localized.js";
import { BattleContentError } from "../battle/sim/definitions.js";
import { RewardBundleSchema, unknownRewardItems, type RewardBundle } from "../economy/reward-granter.js";

/** Towers are addressed as `towerId:floor` in the battle target (64 chars) and `tower:<id>:<floor>` as stage id (64 chars). */
const towerId = z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/);
const id = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

export const MAX_TOWER_FLOORS = 50;

export const TowerFloorSchema = z.strictObject({
  encounter: id,
  difficulty: id,
  /** Optional floor name; clients show "Floor N" without it. */
  title: LocalizedTextSchema.optional(),
  /** Granted the first time the floor is cleared (ledger reason TOWER_REWARD). */
  reward: RewardBundleSchema,
  threeStarSeconds: z.number().finite().positive().optional(),
});

export const TowerSchema = z.strictObject({
  id: towerId,
  title: LocalizedTextSchema,
  description: LocalizedTextSchema,
  /** Art key of the banner (resolved by the Unity asset). */
  banner: z.string().max(64).default(""),
  /** ISO 8601 UTC moments: the tower is playable from `startsAt` until `endsAt`. */
  startsAt: z.string().max(40),
  endsAt: z.string().max(40),
  floors: z.array(TowerFloorSchema).min(1).max(MAX_TOWER_FLOORS),
});

export type TowerContent = z.infer<typeof TowerSchema>;
export type TowerFloor = Omit<z.infer<typeof TowerFloorSchema>, "reward"> & { reward: RewardBundle };

export type TowerRefs = { knownItem: (itemId: string) => boolean; hasEncounter: (id: string) => boolean; hasDifficulty: (id: string) => boolean };

/** A validated event tower. */
export class TowerDefinition {
  readonly id: string;
  readonly title: LocalizedText;
  readonly description: LocalizedText;
  readonly banner: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly floors: readonly TowerFloor[];

  constructor(content: TowerContent, refs: TowerRefs) {
    this.startsAtMs = Date.parse(content.startsAt);
    this.endsAtMs = Date.parse(content.endsAt);
    if (!Number.isFinite(this.startsAtMs) || !Number.isFinite(this.endsAtMs)) throw new BattleContentError(`Tower ${content.id}: invalid startsAt / endsAt.`);
    if (this.endsAtMs <= this.startsAtMs) throw new BattleContentError(`Tower ${content.id}: endsAt must be after startsAt.`);
    content.floors.forEach((floor, index) => {
      const where = `Tower ${content.id} floor ${index + 1}`;
      if (!refs.hasEncounter(floor.encounter)) throw new BattleContentError(`${where}: unknown encounter ${floor.encounter}.`);
      if (!refs.hasDifficulty(floor.difficulty)) throw new BattleContentError(`${where}: unknown difficulty ${floor.difficulty}.`);
      const unknown = unknownRewardItems(floor.reward as RewardBundle, refs.knownItem);
      if (unknown.length > 0) throw new BattleContentError(`${where}: unknown reward item ${unknown[0]}.`);
    });
    this.id = content.id;
    this.title = content.title;
    this.description = content.description;
    this.banner = content.banner;
    this.floors = Object.freeze([...(content.floors as TowerFloor[])]);
  }

  isRunning(nowMs: number): boolean {
    return nowMs >= this.startsAtMs && nowMs < this.endsAtMs;
  }
}

/** Validated event towers of the content. */
export class TowerCatalog {
  readonly towers: readonly TowerDefinition[];
  private readonly byId = new Map<string, TowerDefinition>();

  constructor(content: readonly TowerContent[], refs: TowerRefs) {
    const towers = content.map((tower) => new TowerDefinition(tower, refs));
    for (const tower of towers) {
      if (this.byId.has(tower.id)) throw new BattleContentError(`Duplicate tower id: ${tower.id}.`);
      this.byId.set(tower.id, tower);
    }
    this.towers = Object.freeze(towers);
  }

  get(id: string): TowerDefinition | undefined {
    return this.byId.get(id);
  }
}
