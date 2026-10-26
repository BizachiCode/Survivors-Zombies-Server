// Room `battle`: one player's authoritative battle, in deterministic lockstep with the client.
//
// The server runs the simulation (sim/battle-simulation.ts, a port of the client's C# code) at its own pace and is the
// only one deciding anything: commands are validated and applied here, and the result (stars, rewards) is recorded by
// BattleService when the simulation ends. The client runs a replica built from the same spec and advances it only to
// the ticks the server confirms, applying the accepted commands at the ticks the server applied them; state hashes
// detect a desync, and `sync` sends the full state to repair it. Battle time only runs while the player is connected
// and has asked for `start` / `sync` since joining (so no frame is sent before its handlers exist). See docs/PROTOCOL.md.

import { performance } from "node:perf_hooks";
import { localize } from "../../shared/localized.js";

import { ServerError, type AuthContext, type Client } from "@colyseus/core";
import { Schema } from "@colyseus/schema";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom, type RoomIdentity } from "../../shared/rooms/authenticated-room.js";
import { bindRoom } from "../../shared/rooms/base-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { BattleOutcomeKind } from "./battle-rules.js";
import type { BattleService, PreparedBattle } from "./battle.service.js";
import {
  BattleCommandSchema, BattleJoinOptionsSchema, BattleSpeedSchema, BattleSyncSchema,
  type BattleCommandMessage, type BattleSpeedMessage, type BattleSyncMessage,
} from "./battle.validation.js";
import { applyCommand, type CommandOutcome } from "./sim/battle-command.js";
import type { BattleSimulation } from "./sim/battle-simulation.js";
import { buildBattle } from "./sim/battle-spec.js";
import { AbilityResult, MatchPhase, PlacementResult } from "./sim/definitions.js";

/** Server frame (and simulation interval), in ms. Frames confirm every tick stepped since the previous one. */
export const FRAME_MS = 50;
/** A state hash is sent for every tick multiple of this. */
export const HASH_EVERY_TICKS = 20;
const MAX_STEPS_PER_FRAME = 8;

export type BattleRoomLimits = {
  /** Seconds a dropped player has to reconnect (battle time stands still meanwhile). */
  reconnectSeconds: number;
  /** A battle paused longer than this is abandoned. */
  maxPauseMs: number;
  /** Wall-clock cap of a battle (abandoned beyond it). */
  maxBattleMs: number;
  /** How long the room stays open after the result, for the client to read it. */
  resultLingerMs: number;
};

export const DEFAULT_BATTLE_LIMITS: BattleRoomLimits = {
  reconnectSeconds: 60,
  maxPauseMs: 10 * 60_000,
  maxBattleMs: 60 * 60_000,
  resultLingerMs: 30_000,
};

export class BattleState extends Schema {}

export type BattleRoomDeps = {
  battles: BattleService;
  /** Per-user limiter of `cmd` and `speed`. */
  commandLimiter: RateLimiter;
  /** Per-user limiter of `sync`. */
  syncLimiter: RateLimiter;
  limits?: BattleRoomLimits;
};

type BattleIdentity = RoomIdentity & { prepared: PreparedBattle };

/** Join refusals answered as 404 (the rest, such as locked targets or missing tickets, are 409). */
const NOT_FOUND = new Set<string>([ErrorCode.STAGE_UNKNOWN, ErrorCode.BATTLE_MODE_UNKNOWN, ErrorCode.TOWER_UNKNOWN, ErrorCode.ARENA_DISABLED]);

/** Running battles of this process by user: starting a new battle abandons the previous one. */
const activeBattles = new Map<string, BattleRoom>();

/** Number of battles running in this process (monitoring, tests). */
export function activeBattleCount(): number {
  return activeBattles.size;
}

/** The `battle` room class with its dependencies bound (its static onAuth needs them too). */
export function bindBattleRoom(deps: BattleRoomDeps): new () => BattleRoom {
  const Bound = bindRoom(BattleRoom, deps);
  Object.defineProperty(Bound, "onAuth", {
    value: (token: string, options: unknown, context: AuthContext) => BattleRoom.authorize(deps, token, options, context),
  });
  return Bound;
}

export class BattleRoom extends AuthenticatedRoom<BattleState, BattleRoomDeps> {
  maxClients = 1;
  state = new BattleState();

  private prepared: PreparedBattle | null = null;
  private battle: BattleSimulation | null = null;
  private speed = 1;
  private accumulator = 0;
  private pendingCommands: unknown[][] = [];
  private pendingHashes: number[][] = [];
  private lastSentTick = -1;
  private speedChanged = false;
  private connected = false;
  /** The client asked for `start` / `sync` since its last (re)connection: its frame handlers are in place. */
  private ready = false;
  private finished = false;
  private startedAt = 0;
  private pausedSince = 0;
  /** performance.now() of the previous frame (the room clock's delta also counts its other timers' ticks). */
  private lastFrameAt = 0;
  private recording: Promise<void> | null = null;

  /**
   * Matchmaking check (before the room exists): the access token, then the stage (unknown → 404 STAGE_UNKNOWN,
   * locked → 409 STAGE_LOCKED as the matchmaking error). The prepared battle travels in `client.auth`.
   */
  static async authorize(deps: BattleRoomDeps, token: string, options: unknown, context: AuthContext): Promise<BattleIdentity | false> {
    const identity = await AuthenticatedRoom.onAuth(token, options, context);
    if (!identity) return false;
    const parsed = BattleJoinOptionsSchema.safeParse(options);
    if (!parsed.success) throw new ServerError(400, ErrorCode.INVALID_PAYLOAD);
    try {
      return { ...identity, prepared: await deps.battles.prepareMode(identity.userId, parsed.data.mode, parsed.data.target, parsed.data.lang) };
    } catch (error) {
      if (error instanceof AppError) throw new ServerError(NOT_FOUND.has(error.errorCode) ? 404 : 409, error.errorCode);
      throw error;
    }
  }

  private get limits(): BattleRoomLimits {
    return this.deps.limits ?? DEFAULT_BATTLE_LIMITS;
  }

  onCreate(): void {
    this.autoDispose = true;
    // Nothing is synchronized through the state: the battle travels as frames (messages).
    this.setPatchRate(null);

    this.handleAuthenticatedRequest<BattleCommandMessage>("cmd", {
      schema: BattleCommandSchema,
      handle: async ({ userId }, command) => {
        if (!(await this.deps.commandLimiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        const battle = this.requireLive();
        const tick = battle.ticks;
        const refusal = precheck(battle, command);
        if (refusal) throw new AppError(refusal);
        const outcome = applyCommand(battle, command);
        battle.drainEvents();
        if (!outcome.ok) throw new AppError(refusalOf(outcome));
        this.pendingCommands.push([tick, command.kind, "id" in command ? command.id : null, "lane" in command ? command.lane : -1, "column" in command ? command.column : -1]);
        if (command.kind === "pause") this.pausedSince = Date.now();
        if (command.kind === "resume") this.accumulator = 0;
        return { ok: true, tick };
      },
    });

    this.handleAuthenticatedRequest<BattleSpeedMessage>("speed", {
      schema: BattleSpeedSchema,
      handle: async ({ userId }, { speed }) => {
        if (!(await this.deps.commandLimiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        this.requireLive();
        if (speed !== this.speed) {
          this.speed = speed;
          this.speedChanged = true;
        }
        return { ok: true, speed };
      },
    });

    this.handleAuthenticatedRequest<BattleSyncMessage>("start", {
      schema: BattleSyncSchema,
      handle: async ({ userId }) => {
        if (!(await this.deps.syncLimiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        const { battle, prepared } = this;
        if (!battle || this.finished) throw new AppError(ErrorCode.BATTLE_NOT_RUNNING);
        this.ready = true;
        return {
          ok: true,
          battleId: prepared.battleId,
          mode: prepared.mode,
          target: prepared.target,
          stageId: prepared.stage.id,
          title: localize(prepared.stage.title, undefined),
          threeStarSeconds: prepared.stage.threeStarSeconds,
          ...prepared.info,
          // JSON text: every number must reach the client's simulation bit for bit.
          spec: JSON.stringify(prepared.spec),
          contentHash: battle.contentHash,
          hashEvery: HASH_EVERY_TICKS,
          ...this.snapshot(),
        };
      },
    });

    this.handleAuthenticatedRequest<BattleSyncMessage>("sync", {
      schema: BattleSyncSchema,
      handle: async ({ userId }) => {
        if (!(await this.deps.syncLimiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        if (!this.battle) throw new AppError(ErrorCode.BATTLE_NOT_RUNNING);
        this.ready = true;
        return { ok: true, ...this.snapshot() };
      },
    });

    this.lastFrameAt = performance.now();
    this.setSimulationInterval(() => {
      const now = performance.now();
      const elapsed = now - this.lastFrameAt;
      this.lastFrameAt = now;
      this.frame(elapsed);
    }, FRAME_MS);
  }

  onJoin(client: Client): void {
    const { prepared } = client.auth as BattleIdentity;
    this.prepared = prepared;
    this.battle = buildBattle(prepared.spec);
    activeBattles.get(prepared.userId)?.replace();
    activeBattles.set(prepared.userId, this);
    this.connected = true;
    this.startedAt = Date.now();
    this.logger.info(`battle ${prepared.battleId} prepared: ${prepared.mode} ${prepared.stage.id} (user ${prepared.userId})`);
  }

  onDrop(client: Client): void {
    // Battle time stands still while the player is away (until it asks for `sync` again).
    this.connected = false;
    this.ready = false;
    this.accumulator = 0;
    if (!this.finished) this.allowReconnection(client, this.limits.reconnectSeconds);
  }

  onReconnect(): void {
    this.connected = true;
    this.accumulator = 0;
  }

  onLeave(): void {
    this.connected = false;
    if (!this.finished) this.abandon("left");
  }

  async onDispose(): Promise<void> {
    if (!this.finished && this.battle) this.abandon("disposed");
    if (this.prepared && activeBattles.get(this.prepared.userId) === this) activeBattles.delete(this.prepared.userId);
    await this.recording;
  }

  /** A newer battle of the same player started: this one is abandoned. */
  replace(): void {
    if (!this.finished) this.abandon("replaced");
  }

  // ------------------------------------------------------------------ lockstep
  private frame(deltaMs: number): void {
    const battle = this.battle;
    if (!battle || this.finished) return;
    const now = Date.now();
    if (now - this.startedAt > this.limits.maxBattleMs) return this.abandon("time limit");
    if (!this.connected || !this.ready) return;
    if (battle.phase === MatchPhase.Paused && now - this.pausedSince > this.limits.maxPauseMs) return this.abandon("paused too long");

    if (battle.phase === MatchPhase.Running) {
      const tick = battle.settings.tickSeconds;
      this.accumulator += (Math.min(deltaMs, 250) / 1000) * this.speed;
      for (let steps = 0; this.accumulator + 1e-9 >= tick && steps < MAX_STEPS_PER_FRAME && !battle.isOver; steps++) {
        battle.step();
        this.accumulator -= tick;
        battle.drainEvents();
        // Every HASH_EVERY_TICKS ticks, and the final tick, so the client can confirm how the battle ended.
        if (battle.ticks % HASH_EVERY_TICKS === 0 || battle.isOver) this.pendingHashes.push([battle.ticks, battle.stateHash()]);
      }
    } else this.accumulator = 0;

    this.flush();
    if (battle.isOver) this.complete();
  }

  /** Sends the ticks stepped, the commands applied and the hashes computed since the last frame. */
  private flush(): void {
    const battle = this.battle;
    if (!battle) return;
    const tick = battle.ticks;
    if (tick === this.lastSentTick && this.pendingCommands.length === 0 && this.pendingHashes.length === 0 && !this.speedChanged) return;
    const frame: Record<string, unknown> = { t: tick };
    if (this.pendingCommands.length > 0) frame.c = this.pendingCommands;
    if (this.pendingHashes.length > 0) frame.h = this.pendingHashes;
    if (this.speedChanged) frame.s = this.speed;
    this.broadcast("f", frame);
    this.pendingCommands = [];
    this.pendingHashes = [];
    this.speedChanged = false;
    this.lastSentTick = tick;
  }

  /**
   * Full state at the current tick. Pending frames are flushed first: everything the client received before this answer
   * is already part of the checkpoint, so it drops it and continues from here.
   */
  private snapshot(): { tick: number; speed: number; checkpoint: string } {
    this.flush();
    return { tick: this.battle.ticks, speed: this.speed, checkpoint: JSON.stringify(this.battle.capture()) };
  }

  private requireLive(): BattleSimulation {
    const battle = this.battle;
    if (!battle || this.finished || !this.connected || !this.ready || battle.isOver) throw new AppError(ErrorCode.BATTLE_NOT_RUNNING);
    return battle;
  }

  // ------------------------------------------------------------------ end
  private complete(): void {
    const battle = this.battle;
    this.record(battle.phase === MatchPhase.Victory ? "VICTORY" : "DEFEAT", true);
  }

  private abandon(reason: string): void {
    if (this.finished || !this.battle) return;
    this.logger.info(`battle ${this.prepared.battleId} abandoned (${reason})`);
    this.record("ABANDONED", false);
    void this.disconnect();
  }

  private record(kind: BattleOutcomeKind, announce: boolean): void {
    if (this.finished) return;
    this.finished = true;
    const battle = this.battle;
    const prepared = this.prepared;
    if (activeBattles.get(prepared.userId) === this) activeBattles.delete(prepared.userId);
    const outcome = {
      kind, seconds: battle.time, ticks: battle.ticks, baseHealth: battle.baseHealth, maxBaseHealth: battle.settings.baseHealth, kills: battle.kills,
      placed: battle.placedCount, merges: battle.upgradedCount, waves: battle.currentWave,
    };
    this.recording = this.deps.battles.finish(prepared, outcome, battle.contentHash).then(
      (result) => {
        this.logger.info(`battle ${prepared.battleId} ${kind}: ${result.stars} stars, ${outcome.seconds.toFixed(1)} s`);
        if (announce) this.broadcast("result", { ok: true, ...result });
      },
      (error) => {
        this.logger.error(`battle ${prepared.battleId} result not recorded:`, error);
        if (announce) this.broadcast("result", { ok: false, error: error instanceof AppError ? error.errorCode : ErrorCode.SERVER_ERROR });
      },
    ).finally(() => {
      if (announce) this.clock.setTimeout((): void => { void this.disconnect(); }, this.limits.resultLingerMs);
    });
  }
}

/** Reasons the simulation reports only as `false` (upgrade, remove, pause, resume). */
function precheck(battle: BattleSimulation, command: BattleCommandMessage): string | null {
  if (command.kind === "upgrade") {
    const defender = battle.getDefender(command.lane, command.column);
    if (defender && defender.level + 1 < defender.definition.levels.length && battle.energy + 0.000001 < defender.definition.levels[defender.level + 1].upgradeCost) {
      return ErrorCode.BATTLE_INSUFFICIENT_ENERGY;
    }
  }
  if (command.kind !== "resume" && battle.phase !== MatchPhase.Running) return ErrorCode.BATTLE_NOT_RUNNING;
  return null;
}

function refusalOf(outcome: CommandOutcome): string {
  if (outcome.placement !== undefined) {
    switch (outcome.placement) {
      case PlacementResult.MatchNotRunning: return ErrorCode.BATTLE_NOT_RUNNING;
      case PlacementResult.UnknownCard: return ErrorCode.BATTLE_UNKNOWN_CARD;
      case PlacementResult.OutsideBoard: return ErrorCode.BATTLE_OUTSIDE_BOARD;
      case PlacementResult.Occupied: return ErrorCode.BATTLE_OCCUPIED;
      case PlacementResult.CoolingDown: return ErrorCode.BATTLE_COOLING_DOWN;
      case PlacementResult.InsufficientEnergy: return ErrorCode.BATTLE_INSUFFICIENT_ENERGY;
    }
  }
  if (outcome.ability !== undefined) {
    switch (outcome.ability) {
      case AbilityResult.MatchNotRunning: return ErrorCode.BATTLE_NOT_RUNNING;
      case AbilityResult.UnknownAbility: return ErrorCode.BATTLE_UNKNOWN_ABILITY;
      case AbilityResult.OutsideBoard: return ErrorCode.BATTLE_OUTSIDE_BOARD;
      case AbilityResult.CoolingDown: return ErrorCode.BATTLE_COOLING_DOWN;
      case AbilityResult.InsufficientEnergy: return ErrorCode.BATTLE_INSUFFICIENT_ENERGY;
      case AbilityResult.NoTarget: return ErrorCode.BATTLE_NO_TARGET;
    }
  }
  return ErrorCode.BATTLE_REJECTED;
}
