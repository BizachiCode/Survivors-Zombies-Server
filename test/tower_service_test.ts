// Event tower rules on in-memory repositories: content checks, the tower list, and floors played as authoritative
// battles of mode "tower" through BattleService (prepare = access checks, finish = progress + reward).
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

import type { BattleOutcome } from "../src/modules/battle/battle-rules.js";
import { BattleCatalog } from "../src/modules/battle/content/battle-content.js";
import { BattleContentError } from "../src/modules/battle/sim/definitions.js";
import { TowerService } from "../src/modules/tower/tower.service.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { MemoryTowerRepository } from "./support/memory-tower.js";
import { towerContent } from "./support/tower-fixtures.js";
import { createTestServices, testClock, TEST_CONTENT_PATH } from "./support/test-services.js";

// testClock() = 2026-10-21 12:00 UTC.

function setup() {
  const catalog = BattleCatalog.fromJson(towerContent());
  const services = createTestServices({ clock: testClock(), catalog });
  const repository = new MemoryTowerRepository();
  const tower = new TowerService(catalog, repository, services.clock);
  services.battles.registerMode(tower.mode);
  return { ...services, tower, repository };
}

async function player(services: ReturnType<typeof setup>, device: string) {
  return (await services.auth.deviceLogin({ deviceId: device, platform: "test" })).userId;
}

function outcome(kind: BattleOutcome["kind"]): BattleOutcome {
  return { kind, seconds: 20, ticks: 400, baseHealth: kind === "VICTORY" ? 3 : 0, maxBaseHealth: 3, kills: 2, waves: 1 };
}

async function play(services: ReturnType<typeof setup>, userId: string, target: string, kind: BattleOutcome["kind"] = "VICTORY") {
  return services.battles.finish(await services.battles.prepareMode(userId, "tower", target), outcome(kind), "hash");
}

async function rejects(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

describe("tower content", () => {
  it("loads towers and rejects broken references", () => {
    assert.equal(BattleCatalog.fromJson(towerContent()).towers!.towers.length, 2);
    assert.throws(() => BattleCatalog.fromJson(towerContent((t) => { t[0].floors[0].encounter = "ghost"; })), BattleContentError);
    assert.throws(() => BattleCatalog.fromJson(towerContent((t) => { t[0].floors[1].difficulty = "ghost"; })), /unknown difficulty/);
    assert.throws(() => BattleCatalog.fromJson(towerContent((t) => { t[0].floors[2].reward = { items: { ghost: 1 } }; })), /unknown reward item/);
    assert.throws(() => BattleCatalog.fromJson(towerContent((t) => { t[1].id = "kraken"; })), /Duplicate tower/);
    assert.throws(() => BattleCatalog.fromJson(towerContent((t) => { t[0].endsAt = t[0].startsAt; })), /endsAt/);
    assert.throws(() => BattleCatalog.fromJson(towerContent((t) => { t[0].startsAt = "soon"; })), /invalid/);
    assert.throws(() => BattleCatalog.fromJson(towerContent((t) => { t[0].floors = []; })), BattleContentError);
    assert.throws(() => BattleCatalog.fromJson(towerContent((t) => { t[0].id = "a".repeat(41); })), BattleContentError);
  });

  it("has no towers when the content has none", () => {
    assert.equal(BattleCatalog.fromFile(TEST_CONTENT_PATH).towers, null);
  });
});

describe("tower service", () => {
  it("lists running towers and recently ended ones, localized, with the player's floors", async () => {
    const services = setup();
    const userId = await player(services, "device-tower-0001");
    const info = await services.tower.info(userId, "pt");
    assert.deepEqual(info.towers.map((t) => [t.id, t.running]), [["old", false], ["kraken", true]]);
    const kraken = info.towers[1];
    assert.equal(kraken.title, "Torre do Kraken");
    assert.equal(kraken.startsAtUnix, Date.UTC(2026, 9, 20) / 1000);
    assert.equal(kraken.highestCleared, 0);
    assert.deepEqual(kraken.floors.map((f) => [f.floor, f.title, f.cleared, f.current, f.locked]), [
      [1, "", false, true, false], [2, "Guardado", false, false, true], [3, "", false, false, true],
    ]);
    assert.deepEqual(kraken.floors[0].reward, { currencies: { coins: 100 }, items: {}, exp: 0 });

    services.clock.set(Date.UTC(2026, 9, 23));
    assert.deepEqual((await services.tower.info(userId)).towers.map((t) => t.id), ["kraken"], "ended towers disappear after two days");
    services.clock.set(Date.UTC(2026, 9, 19));
    assert.deepEqual((await services.tower.info(userId)).towers.map((t) => t.id), ["old"], "upcoming towers are not listed");
  });

  it("climbs floor by floor: rewards once, replays grant nothing, locked floors are refused", async () => {
    const services = setup();
    const userId = await player(services, "device-tower-0002");

    await rejects(services.battles.prepareMode(userId, "tower", "kraken:2"), "TOWER_FLOOR_LOCKED");
    await assert.rejects(services.battles.prepareMode(userId, "tower", "kraken:2"), (e: any) => e.extra?.nextFloor === 1);

    const defeat = await play(services, userId, "kraken:1", "DEFEAT");
    assert.deepEqual(defeat.reward, { currencies: {}, items: {}, exp: 0 });
    assert.equal((defeat as any).tower.cleared, false);

    const first = await play(services, userId, "kraken:1");
    assert.equal(first.mode, "tower");
    assert.equal(first.stageId, "tower:kraken:1");
    assert.deepEqual([first.stars, first.firstClear], [0, true]);
    assert.deepEqual(first.reward, { currencies: { coins: 100 }, items: {}, exp: 0 });
    assert.deepEqual((first as any).tower, { towerId: "kraken", floor: 1, floors: 3, cleared: true, highestCleared: 1 });
    assert.deepEqual(first.wallet, { coins: 100, gems: 0 });

    const replay = await play(services, userId, "kraken:1");
    assert.deepEqual(replay.reward, { currencies: {}, items: {}, exp: 0 });
    assert.deepEqual([replay.firstClear, (replay as any).tower.cleared, (replay as any).tower.highestCleared], [false, false, 1]);
    assert.deepEqual(replay.wallet, { coins: 100, gems: 0 });

    const second = await play(services, userId, "kraken:2");
    assert.deepEqual(second.reward, { currencies: {}, items: { plant_xp: 5 }, exp: 20 });
    assert.equal(second.profile.exp, 20);
    assert.ok(services.store.itemLedger.some((e) => e.userId === userId && e.itemId === "plant_xp" && e.delta === 5 && e.reason === "TOWER_REWARD"));

    assert.equal((await services.battles.prepareMode(userId, "tower", "kraken:3")).stage.id, "tower:kraken:3", "the next floor is open");
  });

  it("refuses unknown towers and floors, malformed targets and towers that are not running", async () => {
    const services = setup();
    const userId = await player(services, "device-tower-0003");
    for (const target of ["ghost:1", "kraken:0", "kraken:4", "kraken", "kraken:x", ":1", ""]) {
      await rejects(services.battles.prepareMode(userId, "tower", target), "TOWER_UNKNOWN");
    }
    await rejects(services.battles.prepareMode(userId, "tower", "old:1"), "TOWER_NOT_RUNNING");
    services.clock.set(Date.UTC(2026, 11, 1));
    await rejects(services.battles.prepareMode(userId, "tower", "kraken:1"), "TOWER_NOT_RUNNING");
  });

  it("records the ledger reason TOWER_REWARD and keeps each player's progress apart", async () => {
    const services = setup();
    const ana = await player(services, "device-tower-0004");
    const bob = await player(services, "device-tower-0005");
    await play(services, ana, "kraken:1");
    await play(services, ana, "kraken:2");
    await play(services, ana, "kraken:3");
    assert.deepEqual(services.store.ledger.filter((e) => e.userId === ana).map((e) => [e.currencyId, e.delta, e.reason]),
      [["coins", 100, "TOWER_REWARD"], ["gems", 7, "TOWER_REWARD"]]);
    const mine = (await services.tower.info(ana)).towers.find((t) => t.id === "kraken")!;
    assert.deepEqual(mine.floors.map((f) => [f.cleared, f.current, f.locked]), [[true, false, false], [true, false, false], [true, false, false]]);
    const his = (await services.tower.info(bob)).towers.find((t) => t.id === "kraken")!;
    assert.equal(his.highestCleared, 0);
    await rejects(services.battles.prepareMode(bob, "tower", "kraken:2"), "TOWER_FLOOR_LOCKED");
  });

  it("starts the floor's encounter with the floor's difficulty and counts no stars or stages", async () => {
    const services = setup();
    const userId = await player(services, "device-tower-0006");
    const prepared = await services.battles.prepareMode(userId, "tower", "kraken:1");
    assert.deepEqual([prepared.stage.encounter, prepared.stage.difficulty], ["open_run", "normal"]);
    assert.deepEqual(prepared.info, { tower: { towerId: "kraken", floor: 1, floors: 3 } });
    assert.deepEqual(prepared.context, { towerId: "kraken", floor: 1 });
  });
});
