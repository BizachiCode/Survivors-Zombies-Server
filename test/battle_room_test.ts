// Wire protocol of the `battle` and `campaign` rooms through a real Colyseus server and SDK client (in-memory
// repositories). The test drives a replica exactly like the Unity client does (BattleLockstep.cs): build it from the
// `start` spec, step it to the confirmed ticks, apply the relayed commands at their ticks, compare the state hashes.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { defineRoom, defineServer } from "@colyseus/core";
import { boot, type ColyseusTestServer } from "@colyseus/testing";

import { AuthRoom } from "../src/modules/auth/auth.room.js";
import { activeBattleCount, bindBattleRoom, type BattleRoomLimits } from "../src/modules/battle/battle.room.js";
import { CampaignRoom } from "../src/modules/battle/campaign.room.js";
import { CollectionRoom } from "../src/modules/collection/collection.room.js";
import { ShopRoom } from "../src/modules/shop/shop.room.js";
import { applyCommand, type BattleCommandKind } from "../src/modules/battle/sim/battle-command.js";
import type { BattleSimulation } from "../src/modules/battle/sim/battle-simulation.js";
import { BattleSpecSchema, buildBattle } from "../src/modules/battle/sim/battle-spec.js";
import { MatchPhase } from "../src/modules/battle/sim/definitions.js";
import { configureRoomAuthentication } from "../src/shared/rooms/authenticated-room.js";
import { bindRoom } from "../src/shared/rooms/base-room.js";
import { unlimited } from "../src/shared/security/rate-limiter.js";
import { createTestServices } from "./support/test-services.js";

const PORT = 2592;
const LIMITS: BattleRoomLimits = { reconnectSeconds: 5, maxPauseMs: 60_000, maxBattleMs: 120_000, resultLingerMs: 500 };

type Frame = { t: number; c?: [number, BattleCommandKind, string | null, number, number][]; h?: [number, number][]; s?: number };

/** The client side of the lockstep. */
class Replica {
  battle: BattleSimulation;
  confirmed = 0;
  checked = 0;
  mismatches = 0;
  frames = 0;
  speed = 1;
  private commands: Frame["c"] = [];
  private hashes = new Map<number, number>();

  constructor(start: any) {
    this.battle = buildBattle(BattleSpecSchema.parse(JSON.parse(start.spec)));
    assert.equal(this.battle.contentHash, start.contentHash);
    assert.equal(start.tick, 0);
    assert.deepEqual(JSON.parse(start.checkpoint), this.battle.capture());
  }

  onFrame(frame: Frame): void {
    this.frames++;
    if (frame.c) this.commands.push(...frame.c);
    if (frame.h) for (const [tick, hash] of frame.h) this.hashes.set(tick, hash);
    if (frame.s) this.speed = frame.s;
    this.confirmed = frame.t;
    this.advance();
  }

  private advance(): void {
    for (;;) {
      while (this.commands.length > 0 && this.commands[0][0] === this.battle.ticks) {
        const [, kind, id, lane, column] = this.commands.shift();
        assert.ok(applyCommand(this.battle, { kind, id, lane, column }).ok, `replica rejected ${kind} at ${this.battle.ticks}`);
      }
      if (this.battle.ticks >= this.confirmed) return;
      const before = this.battle.ticks;
      this.battle.step();
      this.battle.drainEvents();
      if (this.battle.ticks === before) return;
      const expected = this.hashes.get(this.battle.ticks);
      if (expected !== undefined) {
        this.checked++;
        if (expected !== this.battle.stateHash()) this.mismatches++;
        this.hashes.delete(this.battle.ticks);
      }
    }
  }
}

function waitFor<T>(predicate: () => T | undefined | false, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

describe("rooms: campaign + battle protocol", () => {
  let colyseus: ColyseusTestServer;
  let services: ReturnType<typeof createTestServices>;

  before(async () => {
    services = createTestServices();
    configureRoomAuthentication(services.authenticator);
    const server = defineServer({
      greet: false,
      rooms: {
        auth: defineRoom(bindRoom(AuthRoom, { auth: services.auth, limiter: unlimited, isMaintenanceEnabled: () => false })),
        campaign: defineRoom(bindRoom(CampaignRoom, { battles: services.battles, queryLimiter: unlimited })),
        collection: defineRoom(bindRoom(CollectionRoom, { collection: services.collection, queryLimiter: unlimited, changeLimiter: unlimited })),
        shop: defineRoom(bindRoom(ShopRoom, { shop: services.shop, queryLimiter: unlimited, buyLimiter: unlimited })),
        battle: defineRoom(bindBattleRoom({ battles: services.battles, commandLimiter: unlimited, syncLimiter: unlimited, limits: LIMITS })),
      },
    });
    colyseus = await boot(server, PORT);
  });

  after(async () => colyseus.shutdown());

  async function signIn(deviceId: string): Promise<string> {
    const auth = await colyseus.sdk.joinOrCreate("auth");
    const answer: any = await auth.request("auth", { type: "device", deviceId, platform: "test" });
    await auth.leave();
    assert.equal(answer.ok, true);
    return answer.accessToken;
  }

  async function startBattle(accessToken: string, stageId: string) {
    const room = await colyseus.sdk.create("battle", { accessToken, stageId });
    const results: any[] = [];
    let replica: Replica;
    room.onMessage("f", (frame: Frame) => replica?.onFrame(frame));
    room.onMessage("result", (result: any) => results.push(result));
    const start: any = await room.request("start", {});
    assert.equal(start.ok, true);
    assert.equal(start.stageId, stageId);
    assert.equal(start.hashEvery, 20);
    replica = new Replica(start);
    return { room, start, replica, results };
  }

  it("plays a battle to victory in lockstep and records the server's result", async () => {
    const accessToken = await signIn("device-room-battle-01");
    const { replica, results } = await startBattle(accessToken, "test_1");

    const result = await waitFor(() => results[0]);
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "VICTORY");
    assert.equal(result.stars, 3);
    assert.equal(result.firstClear, true);
    assert.deepEqual(result.reward, { currencies: { coins: 100, gems: 5 }, items: { "seeds.bomber": 6, plant_xp: 40 }, exp: 110 });
    assert.deepEqual(result.wallet, { coins: 100, gems: 5 });
    assert.equal(result.profile.level, 2);

    await waitFor(() => replica.battle.isOver);
    assert.equal(replica.battle.phase, MatchPhase.Victory);
    assert.equal(replica.battle.time, result.seconds);
    assert.ok(replica.checked >= 1, "state hashes were compared");
    assert.equal(replica.mismatches, 0);

    const campaign = await colyseus.sdk.joinOrCreate("campaign", { accessToken });
    const info: any = await campaign.request("campaign", { type: "info" });
    assert.equal(info.ok, true);
    assert.deepEqual(info.stages.map((s: any) => [s.id, s.unlocked, s.stars]), [
      ["test_1", true, 3], ["test_2", true, 0], ["test_siege", true, 0], ["test_veteran", false, 0],
    ]);
    assert.deepEqual(info.stages.map((s: any) => s.location), ["suburb", "suburb", "", ""], "map locations (empty when absent)");
    await campaign.leave();
  });

  it("refuses locked and unknown stages at matchmaking", async () => {
    const accessToken = await signIn("device-room-battle-02");
    await assert.rejects(colyseus.sdk.create("battle", { accessToken, stageId: "test_2" }), (e: any) => e.code === 409 && /STAGE_LOCKED/.test(e.message));
    await assert.rejects(colyseus.sdk.create("battle", { accessToken, stageId: "nowhere" }), (e: any) => e.code === 404 && /STAGE_UNKNOWN/.test(e.message));
    await assert.rejects(colyseus.sdk.create("battle", { accessToken: "forged", stageId: "test_1" }));
  });

  it("validates commands, relays the accepted ones and keeps the replica in sync", async () => {
    const accessToken = await signIn("device-room-battle-03");
    const { room, replica } = await startBattle(accessToken, "test_siege");

    const placed: any = await room.request("cmd", { kind: "place", id: "shooter", lane: 0, column: 0 });
    assert.equal(placed.ok, true);
    assert.ok(Number.isInteger(placed.tick));
    assert.deepEqual(await room.request("cmd", { kind: "place", id: "shooter", lane: 1, column: 0 }), { ok: false, error: "BATTLE_COOLING_DOWN" });
    assert.deepEqual(await room.request("cmd", { kind: "place", id: "generator", lane: 0, column: 0 }), { ok: false, error: "BATTLE_OCCUPIED" });
    assert.deepEqual(await room.request("cmd", { kind: "place", id: "wizard", lane: 2, column: 2 }), { ok: false, error: "BATTLE_UNKNOWN_CARD" });
    assert.deepEqual(await room.request("cmd", { kind: "place", id: "generator", lane: 9, column: 0 }), { ok: false, error: "BATTLE_OUTSIDE_BOARD" });
    assert.deepEqual(await room.request("cmd", { kind: "place", id: "generator", lane: 1, column: 0, energy: 999 }), { ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await room.request("cmd", { kind: "cast", id: "strike", lane: 0 }), { ok: false, error: "BATTLE_NO_TARGET" });
    assert.equal(((await room.request("cmd", { kind: "upgrade", lane: 0, column: 0 })) as any).ok, true);
    assert.deepEqual(await room.request("cmd", { kind: "upgrade", lane: 0, column: 0 }), { ok: false, error: "BATTLE_REJECTED" });
    assert.equal(((await room.request("cmd", { kind: "place", id: "generator", lane: 1, column: 1 })) as any).ok, true);

    assert.equal(((await room.request("cmd", { kind: "pause" })) as any).ok, true);
    assert.deepEqual(await room.request("cmd", { kind: "place", id: "generator", lane: 2, column: 1 }), { ok: false, error: "BATTLE_NOT_RUNNING" });
    const pausedAt = replica.confirmed;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(replica.confirmed - pausedAt <= 1, "time stands still while paused");
    assert.equal(((await room.request("cmd", { kind: "resume" })) as any).ok, true);

    assert.deepEqual(await room.request("speed", { speed: 2 }), { ok: true, speed: 2 });
    assert.deepEqual(await room.request("speed", { speed: 5 }), { ok: false, error: "INVALID_PAYLOAD" });
    await waitFor(() => replica.speed === 2 && replica.checked >= 2);

    await waitFor(() => replica.battle.ticks === replica.confirmed && replica.battle.defenders.length === 2);
    assert.equal(replica.battle.defenders[0].level, 1, "the upgrade reached the replica");
    assert.equal(replica.mismatches, 0);

    const sync: any = await room.request("sync", {});
    assert.equal(sync.ok, true);
    const checkpoint = JSON.parse(sync.checkpoint);
    assert.equal(checkpoint.contentHash, replica.battle.contentHash);
    assert.equal(checkpoint.ticks, sync.tick);
    assert.equal(checkpoint.defenders.length, 2);

    await room.leave();
    await waitFor(() => [...services.store.battleResults.values()].find((r) => r.stageId === "test_siege" && r.outcome === "ABANDONED"));
  });

  it("stops battle time while the player is away and resumes after a reconnection", async () => {
    const accessToken = await signIn("device-room-battle-04");
    const { room, replica } = await startBattle(accessToken, "test_siege");
    await waitFor(() => replica.confirmed >= 10);
    let reconnected = false;
    room.onReconnect(() => { reconnected = true; });
    room.reconnection.minUptime = 0;
    room.connection.close(4010, "network lost");
    await waitFor(() => reconnected, 8000);
    const sync: any = await room.request("sync", {});
    assert.equal(sync.ok, true);
    const before = sync.tick;
    await waitFor(() => replica.confirmed > before + 5);
    assert.equal(replica.mismatches, 0);
    await room.leave();
  });

  it("serves the collection: cards, items, team, upgrades and their errors", async () => {
    const accessToken = await signIn("device-room-battle-06");
    const room = await colyseus.sdk.joinOrCreate("collection", { accessToken });
    const info: any = await room.request("collection", { type: "info" });
    assert.equal(info.ok, true);
    assert.equal(info.action, "info");
    assert.deepEqual(info.deck, ["shooter", "generator"]);
    assert.deepEqual(info.items, { plant_xp: 30 });
    assert.equal(info.cards.length, 5);
    assert.deepEqual(await room.request("collection", { type: "upgrade", cardId: "shooter" }),
      { action: "upgrade", ok: false, error: "WALLET_INSUFFICIENT_FUNDS", extra: { currencyId: "coins", need: 50, have: 0 } });
    assert.deepEqual(await room.request("collection", { type: "unlock", cardId: "bomber", method: "seeds" }),
      { action: "unlock", ok: false, error: "ITEM_INSUFFICIENT", extra: { itemId: "seeds.bomber", need: 10, have: 0 } });
    assert.deepEqual(await room.request("collection", { type: "set_deck", cards: ["bomber"] }),
      { action: "set_deck", ok: false, error: "DECK_INVALID", extra: { deckSize: 3 } });
    const team: any = await room.request("collection", { type: "set_deck", cards: ["generator"] });
    assert.equal(team.ok, true);
    assert.deepEqual(team.deck, ["generator"]);
    assert.deepEqual(await room.request("collection", { type: "grant", cardId: "bomber" }), { action: "unknown", ok: false, error: "INVALID_PAYLOAD" });
    await room.leave();
  });

  it("serves the shop: offers, purchases and their errors", async () => {
    const accessToken = await signIn("device-room-battle-07");
    const room = await colyseus.sdk.joinOrCreate("shop", { accessToken });
    const info: any = await room.request("shop", { type: "info" });
    assert.equal(info.ok, true);
    assert.deepEqual(info.offers.map((o: any) => o.id), ["xp_pack", "gem_coins", "wild_seeds"]);
    assert.deepEqual(await room.request("shop", { type: "buy", offerId: "xp_pack" }),
      { action: "buy", ok: false, error: "WALLET_INSUFFICIENT_FUNDS", extra: { currencyId: "coins", need: 100, have: 0 } });
    assert.deepEqual(await room.request("shop", { type: "buy", offerId: "wild_seeds" }),
      { action: "buy", ok: false, error: "SHOP_LOCKED", extra: { requiredLevel: 3 } });
    assert.deepEqual(await room.request("shop", { type: "buy" }), { action: "buy", ok: false, error: "INVALID_PAYLOAD" });
    await room.leave();
  });

  it("abandons the previous battle when the player starts another one", async () => {
    const accessToken = await signIn("device-room-battle-05");
    const first = await startBattle(accessToken, "test_siege");
    let firstLeft = false;
    first.room.onLeave(() => { firstLeft = true; });
    const second = await startBattle(accessToken, "test_siege");
    await waitFor(() => firstLeft);
    const placed: any = await second.room.request("cmd", { kind: "place", id: "generator", lane: 0, column: 0 });
    assert.equal(placed.ok, true);
    await second.room.leave();
    await waitFor(() => activeBattleCount() === 0);
  });
});
