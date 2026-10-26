// Battle content the server enforces: cards, enemies, difficulties, encounters and campaign stages, exported from the
// Unity project (Tools > Card Tower Defense > Export Server Content) to content/battle-content.json. The server is the
// only source of the numbers a battle runs with: it resolves a stage into a BattleSpec and sends it to the client.

import { createHash, randomInt } from "node:crypto";
import { LocalizedTextSchema } from "../../../shared/localized.js";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { CURRENCY_IDS, type CurrencyId } from "../../../config/game-config.js";
import {
  AbilitySpecSchema, BattleSettingsSpecSchema, DefenderSpecSchema, EnemySpecSchema, WaveSpecSchema, buildBattle,
  type BattleSpec, type DefenderSpec, type EnemySpec,
} from "../sim/battle-spec.js";
import { BattleContentError } from "../sim/definitions.js";
import { CollectionCatalog, CollectionSchema, ItemSchema, type ItemDefinition } from "../../collection/collection-content.js";
import { ShopCatalog, ShopSchema } from "../../shop/shop-content.js";
import { ProgressionCatalog, ProgressionSchema } from "../../objectives/objectives-content.js";
import { WheelCatalog, WheelSchema } from "../../wheel/wheel-content.js";
import { ArenaCatalog, ArenaSchema } from "../../arena/arena-content.js";
import { TowerCatalog, TowerSchema } from "../../tower/tower-content.js";

export const BATTLE_CONTENT_VERSION = 1;

const int = z.number().int();
const num = z.number().finite();
const id = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

export const RewardSchema = z.strictObject({
  currencies: z.partialRecord(z.enum(CURRENCY_IDS), int.min(0).max(1_000_000_000)),
  /** Items (card seeds, upgrade XP, materials) by item id. */
  items: z.record(z.string(), int.min(1).max(1_000_000_000)).default({}),
  exp: int.min(0).max(1_000_000_000),
});

export const DifficultySchema = z.strictObject({
  id,
  enemyHealth: num.min(0.01),
  enemySpeed: num.min(0.01),
  enemyDamage: num.min(0.01),
});

export const EncounterSchema = z.strictObject({
  id,
  settings: BattleSettingsSpecSchema,
  /** 0 = a fresh random seed per battle (enemy lanes differ each time). */
  seed: int.min(0).max(0xffffffff),
  deck: z.array(id).min(1).max(20),
  /** "player": the player's team (with its collection levels) when the content has a collection; "fixed": always `deck`. */
  deckMode: z.enum(["player", "fixed"]).default("player"),
  waves: z.array(WaveSpecSchema).min(1),
  abilities: z.array(AbilitySpecSchema),
});

export const StageSchema = z.strictObject({
  id,
  /** Plain English title or { en, pt?, es?, zh?, ja?, ko? }; players get it in their language. */
  title: LocalizedTextSchema,
  /** World map location (map node id) the stage belongs to; empty = not on the map. */
  location: z.string().max(64).default(""),
  encounter: id,
  difficulty: id,
  requiredLevel: int.min(0),
  threeStarSeconds: num.positive(),
  prerequisites: z.array(id),
  victoryReward: RewardSchema,
  firstClearBonus: RewardSchema,
  defeatReward: RewardSchema,
});

export const BattleContentSchema = z.strictObject({
  version: z.literal(BATTLE_CONTENT_VERSION),
  defenders: z.array(DefenderSpecSchema),
  enemies: z.array(EnemySpecSchema),
  difficulties: z.array(DifficultySchema).min(1),
  encounters: z.array(EncounterSchema).min(1),
  stages: z.array(StageSchema).min(1).max(1000),
  items: z.array(ItemSchema).default([]),
  /** Card collection (unlocks, levels, team). Without it every battle uses its encounter's deck. */
  collection: CollectionSchema.optional(),
  /** Shop offers (currencies and items for a price, optional daily limits). */
  shop: ShopSchema.optional(),
  /** Missions, achievements, events and the daily login calendar. */
  progression: ProgressionSchema.optional(),
  /** Lucky wheel (segments, free spins per day, spin price, daily limit). */
  wheel: WheelSchema.optional(),
  /** Weekly arena (score battle, tickets, groups, leagues). */
  arena: ArenaSchema.optional(),
  /** Event towers (timed floors with rewards). */
  towers: z.array(TowerSchema).max(20).optional(),
});

export type Reward = { currencies: Partial<Record<CurrencyId, number>>; items: Record<string, number>; exp: number };
export type DifficultyDefinition = z.infer<typeof DifficultySchema>;
export type EncounterDefinition = z.infer<typeof EncounterSchema>;
export type StageDefinition = z.infer<typeof StageSchema>;
export type BattleContent = z.infer<typeof BattleContentSchema>;

/** Permanent card rank scaling (C# DefenderScaling.ApplyRank). */
export function applyRank(card: DefenderSpec, rank: number): DefenderSpec {
  if (!Number.isInteger(rank) || rank < 0 || rank > 100) throw new BattleContentError(`Invalid rank ${rank}.`);
  const multiplier = 1 + rank * 0.1;
  return {
    ...card,
    levels: card.levels.map((s) => ({ ...s, health: s.health * multiplier, damage: s.damage * multiplier, burnDamagePerSecond: s.burnDamagePerSecond * multiplier })),
  };
}

/** Encounter modifiers (C# DifficultyDefinition.Apply). */
export function applyDifficulty(enemy: EnemySpec, difficulty: DifficultyDefinition): EnemySpec {
  return {
    ...enemy,
    health: enemy.health * difficulty.enemyHealth,
    speed: enemy.speed * difficulty.enemySpeed,
    damage: enemy.damage * difficulty.enemyDamage,
    phases: enemy.phases.map((p) => ({ ...p, pulseDamage: p.pulseDamage * difficulty.enemyDamage })),
  };
}

/** A card of the player's team with its collection level. */
export type TeamCard = { cardId: string; level: number };

export type ResolveOptions = {
  /** Fixed seed; defaults to the encounter's, or a random one when the encounter says 0. */
  seed?: number;
  /** Rank of each card of a fixed deck (default 0). */
  rankOf?: (cardId: string) => number;
  /** The player's team; used by "player" encounters when the content has a collection. */
  team?: readonly TeamCard[];
};

/** Validated, cross-referenced battle content. */
export class BattleCatalog {
  readonly stages: readonly StageDefinition[];
  /** SHA-256 of the content file (logged at boot; identifies the content version). */
  readonly fingerprint: string;
  /** Card collection rules, null when the content has none. */
  readonly collection: CollectionCatalog | null;
  /** Shop offers, null when the content has none. */
  readonly shop: ShopCatalog | null;
  /** Objectives and daily rewards, null when the content has none. */
  readonly progression: ProgressionCatalog | null;
  /** Lucky wheel, null when the content has none. */
  readonly wheel: WheelCatalog | null;
  /** Weekly arena, null when the content has none. */
  readonly arena: ArenaCatalog | null;
  /** Event towers, null when the content has none. */
  readonly towers: TowerCatalog | null;
  readonly items: ReadonlyMap<string, ItemDefinition>;
  private readonly stageById = new Map<string, StageDefinition>();
  private readonly encounters = new Map<string, EncounterDefinition>();
  private readonly defenders = new Map<string, DefenderSpec>();
  private readonly enemies = new Map<string, EnemySpec>();
  private readonly difficulties = new Map<string, DifficultyDefinition>();

  private constructor(content: BattleContent, fingerprint: string) {
    this.fingerprint = fingerprint;
    unique(content.defenders, "card", (x) => this.defenders.set(x.id, x), this.defenders);
    unique(content.enemies, "enemy", (x) => this.enemies.set(x.id, x), this.enemies);
    unique(content.difficulties, "difficulty", (x) => this.difficulties.set(x.id, x), this.difficulties);
    unique(content.encounters, "encounter", (x) => this.encounters.set(x.id, x), this.encounters);
    unique(content.stages, "stage", (x) => this.stageById.set(x.id, x), this.stageById);
    this.stages = Object.freeze([...content.stages]);
    const items = new Map<string, ItemDefinition>();
    unique(content.items, "item", (x) => items.set(x.id, x), items);
    this.items = items;
    for (const item of content.items) {
      if (item.card && !this.defenders.has(item.card)) throw new BattleContentError(`Item ${item.id}: unknown card ${item.card}.`);
    }
    this.collection = content.collection
      ? new CollectionCatalog(content.collection, { cards: this.defenders, stages: new Set(this.stageById.keys()), items })
      : null;
    this.shop = content.shop ? new ShopCatalog(content.shop, { items: new Set(items.keys()) }) : null;
    this.progression = content.progression ? new ProgressionCatalog(content.progression, { knownItem: (itemId) => items.has(itemId) }) : null;
    this.wheel = content.wheel ? new WheelCatalog(content.wheel, { knownItem: (itemId) => items.has(itemId) }) : null;
    this.arena = content.arena
      ? new ArenaCatalog(content.arena, {
        knownItem: (itemId) => items.has(itemId), hasEncounter: (x) => this.encounters.has(x), hasDifficulty: (x) => this.difficulties.has(x),
      })
      : null;
    this.towers = content.towers
      ? new TowerCatalog(content.towers, {
        knownItem: (itemId) => items.has(itemId), hasEncounter: (x) => this.encounters.has(x), hasDifficulty: (x) => this.difficulties.has(x),
      })
      : null;

    for (const encounter of content.encounters) {
      for (const cardId of encounter.deck) if (!this.defenders.has(cardId)) throw new BattleContentError(`Encounter ${encounter.id}: unknown card ${cardId}.`);
      if (new Set(encounter.deck).size !== encounter.deck.length) throw new BattleContentError(`Encounter ${encounter.id}: duplicate card in the deck.`);
      for (const wave of encounter.waves) {
        for (const group of wave.groups) if (!this.enemies.has(group.enemy)) throw new BattleContentError(`Encounter ${encounter.id}: unknown enemy ${group.enemy}.`);
      }
    }
    for (const stage of content.stages) {
      if (!this.encounters.has(stage.encounter)) throw new BattleContentError(`Stage ${stage.id}: unknown encounter ${stage.encounter}.`);
      if (!this.difficulties.has(stage.difficulty)) throw new BattleContentError(`Stage ${stage.id}: unknown difficulty ${stage.difficulty}.`);
      for (const reward of [stage.victoryReward, stage.firstClearBonus, stage.defeatReward]) {
        for (const itemId of Object.keys(reward.items)) if (!items.has(itemId)) throw new BattleContentError(`Stage ${stage.id}: unknown reward item ${itemId}.`);
      }
      for (const prerequisite of stage.prerequisites) {
        if (prerequisite === stage.id || !this.stageById.has(prerequisite)) throw new BattleContentError(`Stage ${stage.id}: invalid prerequisite ${prerequisite}.`);
      }
      // Every stage must build: content errors surface at boot, not in a player's battle.
      buildBattle(this.resolve(stage, { seed: 1 }));
    }
    this.rejectCycles();
    if (this.arena) buildBattle(this.resolve(this.modeStage("arena", "Arena", this.arena.encounter, this.arena.difficulty), { seed: 1 }));
    // Every tower floor must build too.
    for (const tower of this.towers?.towers ?? []) {
      tower.floors.forEach((floor, index) => {
        buildBattle(this.resolve(this.modeStage(`tower:${tower.id}:${index + 1}`, tower.id, floor.encounter, floor.difficulty, floor.threeStarSeconds), { seed: 1 }));
      });
    }
  }

  static fromJson(raw: unknown, fingerprint = ""): BattleCatalog {
    const parsed = BattleContentSchema.safeParse(raw);
    if (!parsed.success) throw new BattleContentError(`Invalid battle content: ${z.prettifyError(parsed.error)}`);
    return new BattleCatalog(parsed.data, fingerprint);
  }

  static fromFile(path: string): BattleCatalog {
    const text = readFileSync(path, "utf8");
    return BattleCatalog.fromJson(JSON.parse(text), createHash("sha256").update(text).digest("hex"));
  }

  stage(stageId: string): StageDefinition | undefined {
    return this.stageById.get(stageId);
  }

  hasEncounter(encounterId: string): boolean {
    return this.encounters.has(encounterId);
  }

  hasDifficulty(difficultyId: string): boolean {
    return this.difficulties.has(difficultyId);
  }

  /**
   * A stage-like definition for battle modes outside the campaign (arena, event towers): an encounter with a
   * difficulty and no campaign rewards (the mode decides what the result grants).
   */
  modeStage(id: string, title: string, encounter: string, difficulty: string, threeStarSeconds = 1_000_000): StageDefinition {
    if (!this.encounters.has(encounter)) throw new BattleContentError(`${id}: unknown encounter ${encounter}.`);
    if (!this.difficulties.has(difficulty)) throw new BattleContentError(`${id}: unknown difficulty ${difficulty}.`);
    const none = { currencies: {}, items: {}, exp: 0 };
    return {
      id, title, location: "", encounter, difficulty, requiredLevel: 0, threeStarSeconds, prerequisites: [],
      victoryReward: none, firstClearBonus: none, defeatReward: none,
    };
  }

  /** The battle a stage runs: the encounter with the deck's ranks and the stage's difficulty applied. */
  resolve(stage: StageDefinition, options: ResolveOptions = {}): BattleSpec {
    const encounter = this.encounters.get(stage.encounter);
    const difficulty = this.difficulties.get(stage.difficulty);
    const rankOf = options.rankOf ?? (() => 0);
    const enemies: EnemySpec[] = [];
    const listed = new Set<string>();
    for (const wave of encounter.waves) {
      for (const group of wave.groups) {
        if (listed.has(group.enemy)) continue;
        listed.add(group.enemy);
        enemies.push(applyDifficulty(this.enemies.get(group.enemy), difficulty));
      }
    }
    return {
      version: 1,
      settings: { ...encounter.settings },
      seed: options.seed ?? (encounter.seed !== 0 ? encounter.seed : randomInt(1, 0x100000000)),
      cards: this.usesTeam(encounter) && options.team
        ? options.team.map((card) => this.collection.apply(this.defenders.get(card.cardId), card.level))
        : encounter.deck.map((cardId) => applyRank(this.defenders.get(cardId), rankOf(cardId))),
      enemies,
      waves: encounter.waves.map((wave) => ({ startTime: wave.startTime, groups: wave.groups.map((group) => ({ ...group })) })),
      abilities: encounter.abilities.map((ability) => ({ ...ability })),
    };
  }

  /** True when the stage's battle is played with the player's team (else with its encounter's deck). */
  usesTeam(stageOrEncounter: StageDefinition | EncounterDefinition): boolean {
    const encounter = "encounter" in stageOrEncounter ? this.encounters.get(stageOrEncounter.encounter) : stageOrEncounter;
    return this.collection !== null && encounter.deckMode === "player";
  }

  /** Card definition (battle numbers at collection level 1). */
  defender(cardId: string): DefenderSpec | undefined {
    return this.defenders.get(cardId);
  }

  private rejectCycles(): void {
    const done = new Set<string>();
    const visiting = new Set<string>();
    const visit = (stage: StageDefinition): void => {
      if (done.has(stage.id)) return;
      if (visiting.has(stage.id)) throw new BattleContentError(`Stage prerequisites contain a cycle (${stage.id}).`);
      visiting.add(stage.id);
      for (const prerequisite of stage.prerequisites) visit(this.stageById.get(prerequisite));
      visiting.delete(stage.id);
      done.add(stage.id);
    };
    for (const stage of this.stages) visit(stage);
  }
}

function unique<T extends { id: string }>(items: readonly T[], what: string, add: (item: T) => void, index: Map<string, unknown>): void {
  for (const item of items) {
    if (index.has(item.id)) throw new BattleContentError(`Duplicate ${what} id: ${item.id}.`);
    add(item);
  }
}
