// Plain-data battle description shared with the client (C#: Core/Gameplay/BattleSpec.cs, same JSON names). The server
// resolves a stage into a spec (ranks and difficulty applied), runs it and sends it to the client, which builds the same
// simulation from it.

import { z } from "zod";

import { BattleSimulation } from "./battle-simulation.js";
import {
  ABILITY_EFFECTS, BattleContentError, DEFAULT_REACH, DEFENDER_ROLES,
  abilityDefinition, battleSettings, defenderDefinition, defenderStats, enemyDefinition, enemyPhase, spawnGroup, waveDefinition,
  type AbilityDefinition, type BattleSettings, type DefenderDefinition, type EnemyDefinition, type WaveDefinition,
} from "./definitions.js";

export const BATTLE_SPEC_VERSION = 1;

const int = z.number().int();
const num = z.number().finite();

export const DefenderLevelSpecSchema = z.strictObject({
  health: num,
  damage: num,
  interval: num,
  range: num,
  projectileSpeed: num,
  splashRadius: num,
  slowFraction: num,
  slowDuration: num,
  production: int,
  upgradeCost: int,
  stunDuration: num,
  burnDamagePerSecond: num,
  burnDuration: num,
  pierceCount: int,
});

export const DefenderSpecSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  role: z.enum(DEFENDER_ROLES),
  cost: int,
  recharge: num,
  levels: z.array(DefenderLevelSpecSchema).min(1).max(20),
});

export const EnemyPhaseSpecSchema = z.strictObject({
  healthFraction: num,
  speedMultiplier: num,
  damageMultiplier: num,
  incomingDamageMultiplier: num,
  pulseInterval: num,
  pulseDamage: num,
});

export const EnemySpecSchema = z.strictObject({
  id: z.string(),
  health: num,
  speed: num,
  damage: num,
  attackInterval: num,
  armor: num,
  reward: int,
  baseDamage: int,
  /** Melee reach in cells (absent in older content: the default). */
  reach: num.default(DEFAULT_REACH),
  phases: z.array(EnemyPhaseSpecSchema).max(16),
});

export const SpawnGroupSpecSchema = z.strictObject({
  enemy: z.string(),
  count: int,
  lane: int,
  delay: num,
  interval: num,
  /** -1 = the entrance; otherwise the column the enemies emerge at. */
  column: int.default(-1),
});

export const WaveSpecSchema = z.strictObject({
  startTime: num,
  groups: z.array(SpawnGroupSpecSchema).min(1),
});

export const AbilitySpecSchema = z.strictObject({
  id: z.string(),
  effect: z.enum(ABILITY_EFFECTS),
  cost: int,
  cooldown: num,
  power: num,
});

export const BattleSettingsSpecSchema = z.strictObject({
  lanes: int,
  columns: int,
  startingEnergy: int,
  energyCap: int,
  baseHealth: int,
  passiveEnergyPerSecond: num,
  tickSeconds: num,
  refundFraction: num,
  laneGuards: z.boolean(),
});

export const BattleSpecSchema = z.strictObject({
  version: z.literal(BATTLE_SPEC_VERSION),
  settings: BattleSettingsSpecSchema,
  seed: int.min(0).max(0xffffffff),
  cards: z.array(DefenderSpecSchema).min(1),
  enemies: z.array(EnemySpecSchema),
  waves: z.array(WaveSpecSchema).min(1),
  abilities: z.array(AbilitySpecSchema),
});

export type DefenderLevelSpec = z.infer<typeof DefenderLevelSpecSchema>;
export type DefenderSpec = z.infer<typeof DefenderSpecSchema>;
export type EnemySpec = z.infer<typeof EnemySpecSchema>;
export type WaveSpec = z.infer<typeof WaveSpecSchema>;
export type AbilitySpec = z.infer<typeof AbilitySpecSchema>;
export type BattleSettingsSpec = z.infer<typeof BattleSettingsSpecSchema>;
export type BattleSpec = z.infer<typeof BattleSpecSchema>;

export function buildDefender(spec: DefenderSpec): DefenderDefinition {
  return defenderDefinition(spec.id, spec.name, spec.role, spec.cost, spec.recharge, spec.levels.map((level) => defenderStats(level)));
}

export function buildEnemy(spec: EnemySpec): EnemyDefinition {
  return enemyDefinition({ ...spec, phases: spec.phases.map((phase) => enemyPhase(phase)) });
}

export function buildAbility(spec: AbilitySpec): AbilityDefinition {
  return abilityDefinition(spec.id, spec.effect, spec.cost, spec.cooldown, spec.power);
}

/** Creates the simulation of a (validated) spec; inconsistent content throws {@link BattleContentError}. */
export function buildBattle(spec: BattleSpec): BattleSimulation {
  const enemies = new Map<string, EnemyDefinition>();
  for (const enemy of spec.enemies) {
    if (enemies.has(enemy.id)) throw new BattleContentError(`Duplicate enemy spec: ${enemy.id}`);
    enemies.set(enemy.id, buildEnemy(enemy));
  }
  const waves: WaveDefinition[] = spec.waves.map((wave) => waveDefinition(wave.startTime, wave.groups.map((group) => {
    const enemy = enemies.get(group.enemy);
    if (!enemy) throw new BattleContentError(`Unknown enemy in wave: ${group.enemy}`);
    return spawnGroup(enemy, group.count, group.lane, group.delay, group.interval, group.column);
  })));
  return new BattleSimulation(battleSettings(spec.settings), spec.cards.map(buildDefender), waves, spec.seed, spec.abilities.map(buildAbility));
}

/** Describes definitions as a spec (enemies listed once, in order of first appearance). */
export function toBattleSpec(settings: BattleSettings, deck: readonly DefenderDefinition[], waves: readonly WaveDefinition[], seed: number,
  abilities: readonly AbilityDefinition[] = []): BattleSpec {
  const enemies: EnemySpec[] = [];
  const seen = new Set<string>();
  for (const wave of waves) {
    for (const group of wave.groups) {
      if (seen.has(group.enemy.id)) continue;
      seen.add(group.enemy.id);
      enemies.push({ ...group.enemy, phases: group.enemy.phases.map((phase) => ({ ...phase })) });
    }
  }
  return {
    version: BATTLE_SPEC_VERSION,
    settings: { ...settings },
    seed,
    cards: deck.map((card) => ({ id: card.id, name: card.name, role: card.role, cost: card.cost, recharge: card.recharge, levels: card.levels.map((level) => ({ ...level })) })),
    enemies,
    waves: waves.map((wave) => ({
      startTime: wave.startTime,
      groups: wave.groups.map((group) => ({ enemy: group.enemy.id, count: group.count, lane: group.lane, delay: group.delay, interval: group.interval, column: group.column })),
    })),
    abilities: abilities.map((ability) => ({ ...ability })),
  };
}
