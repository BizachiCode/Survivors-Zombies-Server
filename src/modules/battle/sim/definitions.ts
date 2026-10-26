// Battle content definitions: port of the Unity template's Core/Gameplay/Definitions.cs (+ EnemyPhase/AbilityDefinition
// from CombatExtensions.cs). Same validation as the C# constructors; numbers are IEEE doubles on both sides, so a spec
// builds the same battle here and in the client.

export enum MatchPhase { Running, Paused, Victory, Defeat }
export enum PlacementResult { Success, MatchNotRunning, UnknownCard, OutsideBoard, Occupied, CoolingDown, InsufficientEnergy }
export enum AbilityResult { Success, MatchNotRunning, UnknownAbility, OutsideBoard, CoolingDown, InsufficientEnergy, NoTarget }
export enum BattleEventKind {
  Placed, Removed, Upgraded, Shot, EnemySpawned, EnemyKilled, DefenderDestroyed, EnergyProduced, WaveStarted, GuardTriggered,
  BaseDamaged, Victory, Defeat, EnemyDamaged, DefenderDamaged, AbilityCast, BossPhaseChanged,
  /** An enemy struck (melee hit or boss pulse): entityId is the enemy, amount the damage. */
  EnemyAttacked,
}

/** Names and C# enum values (the content hash writes the value). */
export const DEFENDER_ROLES = ["Shooter", "Generator", "Barrier"] as const;
export type DefenderRole = (typeof DEFENDER_ROLES)[number];
export const ABILITY_EFFECTS = ["LaneStrike", "Stasis", "Repair"] as const;
export type AbilityEffect = (typeof ABILITY_EFFECTS)[number];

export class BattleContentError extends Error {}

/** C# Require.Number: finite and at least `minimum`. */
export function requireNumber(value: number, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new BattleContentError(`${name} is out of range (${value}).`);
  return value;
}

function requireInt(value: number, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new BattleContentError(`${name} is out of range (${value}).`);
  return value;
}

function requireId(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new BattleContentError(`A stable, nonempty ${name} is required.`);
  return value;
}

export type DefenderStats = {
  readonly health: number;
  readonly damage: number;
  readonly interval: number;
  readonly range: number;
  readonly projectileSpeed: number;
  readonly splashRadius: number;
  readonly slowFraction: number;
  readonly slowDuration: number;
  readonly production: number;
  readonly upgradeCost: number;
  readonly stunDuration: number;
  readonly burnDamagePerSecond: number;
  readonly burnDuration: number;
  readonly pierceCount: number;
};

export function defenderStats(s: Partial<DefenderStats> & { health: number }): DefenderStats {
  const stats: DefenderStats = {
    health: requireNumber(s.health, "health", 0.001),
    damage: requireNumber(s.damage ?? 0, "damage"),
    interval: requireNumber(s.interval ?? 1, "interval", 0.05),
    range: requireNumber(s.range ?? 10, "range"),
    projectileSpeed: requireNumber(s.projectileSpeed ?? 8, "projectileSpeed", 0.01),
    splashRadius: requireNumber(s.splashRadius ?? 0, "splashRadius"),
    slowFraction: requireNumber(s.slowFraction ?? 0, "slowFraction"),
    slowDuration: requireNumber(s.slowDuration ?? 0, "slowDuration"),
    production: requireInt(s.production ?? 0, "production", 0, 2147483647),
    upgradeCost: requireInt(s.upgradeCost ?? 0, "upgradeCost", 0, 2147483647),
    stunDuration: requireNumber(s.stunDuration ?? 0, "stunDuration"),
    burnDamagePerSecond: requireNumber(s.burnDamagePerSecond ?? 0, "burnDamagePerSecond"),
    burnDuration: requireNumber(s.burnDuration ?? 0, "burnDuration"),
    pierceCount: s.pierceCount ?? 1,
  };
  if (stats.slowFraction > 1) throw new BattleContentError("slowFraction is out of range.");
  if (!Number.isInteger(stats.pierceCount) || stats.pierceCount < 1 || stats.pierceCount > 20 || (stats.pierceCount > 1 && stats.splashRadius > 0)) {
    throw new BattleContentError("Piercing allows 1-20 direct hits and cannot be combined with splash.");
  }
  return Object.freeze(stats);
}

export type DefenderDefinition = {
  readonly id: string;
  readonly name: string;
  readonly role: DefenderRole;
  readonly cost: number;
  readonly recharge: number;
  readonly levels: readonly DefenderStats[];
};

export function defenderDefinition(id: string, name: string, role: DefenderRole, cost: number, recharge: number, levels: DefenderStats[]): DefenderDefinition {
  requireId(id, "card id");
  requireId(name, "card name");
  if (!DEFENDER_ROLES.includes(role)) throw new BattleContentError(`Unknown defender role: ${role}`);
  requireInt(cost, "cost", 0, 2147483647);
  if (!levels || levels.length === 0 || levels.some((x) => !x)) throw new BattleContentError("At least one complete level is required.");
  return Object.freeze({ id, name, role, cost, recharge: requireNumber(recharge, "recharge"), levels: Object.freeze([...levels]) });
}

export type EnemyPhase = {
  readonly healthFraction: number;
  readonly speedMultiplier: number;
  readonly damageMultiplier: number;
  readonly incomingDamageMultiplier: number;
  readonly pulseInterval: number;
  readonly pulseDamage: number;
};

export function enemyPhase(p: Partial<EnemyPhase> & { healthFraction: number }): EnemyPhase {
  const phase: EnemyPhase = {
    healthFraction: requireNumber(p.healthFraction, "healthFraction", 0.001),
    speedMultiplier: requireNumber(p.speedMultiplier ?? 1, "speedMultiplier", 0.01),
    damageMultiplier: requireNumber(p.damageMultiplier ?? 1, "damageMultiplier"),
    incomingDamageMultiplier: requireNumber(p.incomingDamageMultiplier ?? 1, "incomingDamageMultiplier", 0.01),
    pulseInterval: requireNumber(p.pulseInterval ?? 0, "pulseInterval"),
    pulseDamage: requireNumber(p.pulseDamage ?? 0, "pulseDamage"),
  };
  if (phase.healthFraction >= 1) throw new BattleContentError("healthFraction is out of range.");
  if ((phase.pulseInterval > 0 && phase.pulseInterval < 0.05) || (phase.pulseDamage > 0 && phase.pulseInterval === 0)) {
    throw new BattleContentError("Damaging boss pulses require a positive interval.");
  }
  return Object.freeze(phase);
}

/** Default melee reach: an enemy stops and attacks 0.6 cells past the defender's center. */
export const DEFAULT_REACH = 0.6;

export type EnemyDefinition = {
  readonly id: string;
  readonly health: number;
  /** Cells per second; 0 = stationary. */
  readonly speed: number;
  readonly damage: number;
  readonly attackInterval: number;
  readonly armor: number;
  readonly reward: number;
  readonly baseDamage: number;
  /** Melee reach in cells from the nearest defender's center. */
  readonly reach: number;
  readonly phases: readonly EnemyPhase[];
};

export function enemyDefinition(e: Partial<EnemyDefinition> & { id: string; health: number; speed: number; damage: number }): EnemyDefinition {
  const phases = e.phases ?? [];
  const enemy: EnemyDefinition = {
    id: requireId(e.id, "enemy id"),
    health: requireNumber(e.health, "health", 0.001),
    speed: requireNumber(e.speed, "speed"),
    damage: requireNumber(e.damage, "damage"),
    attackInterval: requireNumber(e.attackInterval ?? 1, "attackInterval", 0.05),
    armor: requireNumber(e.armor ?? 0, "armor"),
    reward: e.reward ?? 10,
    baseDamage: e.baseDamage ?? 1,
    reach: requireNumber(e.reach ?? DEFAULT_REACH, "reach", 0.1),
    phases: Object.freeze([...phases]),
  };
  if (enemy.armor >= 1) throw new BattleContentError("armor is out of range.");
  if (enemy.reach > 20) throw new BattleContentError("reach is out of range.");
  if (!Number.isInteger(enemy.reward) || !Number.isInteger(enemy.baseDamage) || enemy.reward < 0 || enemy.baseDamage < 1) {
    throw new BattleContentError("reward is out of range.");
  }
  if (phases.length > 16) throw new BattleContentError("Invalid boss phases.");
  let previous = 1;
  for (const phase of phases) {
    if (!phase || phase.healthFraction >= previous) throw new BattleContentError("Boss thresholds must strictly descend below 1.");
    previous = phase.healthFraction;
  }
  return Object.freeze(enemy);
}

export type SpawnGroup = {
  readonly enemy: EnemyDefinition;
  readonly count: number;
  /** -1 chooses a seeded random lane. Other values are zero based. */
  readonly lane: number;
  readonly delay: number;
  readonly interval: number;
  /** -1 = the entrance; otherwise the enemies emerge at the center of this column. */
  readonly column: number;
};

export function spawnGroup(enemy: EnemyDefinition, count: number, lane = -1, delay = 0, interval = 1, column = -1): SpawnGroup {
  if (!enemy) throw new BattleContentError("A spawn group needs an enemy.");
  requireInt(count, "count", 1, 10000);
  requireInt(lane, "lane", -1, 2147483647);
  requireInt(column, "column", -1, 2147483647);
  return Object.freeze({ enemy, count, lane, delay: requireNumber(delay, "delay"), interval: requireNumber(interval, "interval", 0.05), column });
}

export type WaveDefinition = {
  readonly startTime: number;
  readonly groups: readonly SpawnGroup[];
};

export function waveDefinition(startTime: number, groups: SpawnGroup[]): WaveDefinition {
  requireNumber(startTime, "startTime");
  if (!groups || groups.length === 0 || groups.some((x) => !x)) throw new BattleContentError("A wave must contain at least one spawn group.");
  return Object.freeze({ startTime, groups: Object.freeze([...groups]) });
}

export type BattleSettings = {
  readonly lanes: number;
  readonly columns: number;
  readonly startingEnergy: number;
  readonly energyCap: number;
  readonly baseHealth: number;
  readonly passiveEnergyPerSecond: number;
  readonly tickSeconds: number;
  readonly refundFraction: number;
  readonly laneGuards: boolean;
};

export function battleSettings(s: Partial<BattleSettings> = {}): BattleSettings {
  const settings: BattleSettings = {
    lanes: s.lanes ?? 5,
    columns: s.columns ?? 9,
    startingEnergy: s.startingEnergy ?? 250,
    energyCap: s.energyCap ?? 999,
    baseHealth: s.baseHealth ?? 3,
    passiveEnergyPerSecond: s.passiveEnergyPerSecond ?? 5,
    tickSeconds: s.tickSeconds ?? 0.05,
    refundFraction: s.refundFraction ?? 0.5,
    laneGuards: s.laneGuards ?? true,
  };
  requireInt(settings.lanes, "lanes", 1, 12);
  requireInt(settings.columns, "columns", 2, 20);
  requireInt(settings.startingEnergy, "startingEnergy", 0, 2147483647);
  requireInt(settings.energyCap, "energyCap", settings.startingEnergy, 2147483647);
  requireInt(settings.baseHealth, "baseHealth", 1, 2147483647);
  requireNumber(settings.tickSeconds, "tickSeconds", 0.01);
  if (settings.tickSeconds > 0.1) throw new BattleContentError("tickSeconds is out of range.");
  requireNumber(settings.refundFraction, "refundFraction");
  if (settings.refundFraction > 1) throw new BattleContentError("refundFraction is out of range.");
  requireNumber(settings.passiveEnergyPerSecond, "passiveEnergyPerSecond");
  if (typeof settings.laneGuards !== "boolean") throw new BattleContentError("laneGuards must be a boolean.");
  return Object.freeze(settings);
}

export type AbilityDefinition = {
  readonly id: string;
  readonly effect: AbilityEffect;
  readonly cost: number;
  readonly cooldown: number;
  readonly power: number;
};

export function abilityDefinition(id: string, effect: AbilityEffect, cost: number, cooldown: number, power: number): AbilityDefinition {
  requireId(id, "ability id");
  if (!ABILITY_EFFECTS.includes(effect) || !Number.isInteger(cost) || cost < 0) throw new BattleContentError("Invalid ability.");
  return Object.freeze({ id, effect, cost, cooldown: requireNumber(cooldown, "cooldown"), power: requireNumber(power, "power", 0.001) });
}

/** A battle event (drained after commands / ticks). */
export type BattleEvent = {
  readonly kind: BattleEventKind;
  readonly entityId: number;
  readonly lane: number;
  readonly amount: number;
  readonly time: number;
};
