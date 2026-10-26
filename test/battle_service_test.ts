// Campaign and battle rules on in-memory repositories: content validation, unlocking, stars, rewards granted exactly
// once through WalletLedger, experience and level ups.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { BattleOutcome } from "../src/modules/battle/battle-rules.js";
import { BattleCatalog, applyDifficulty } from "../src/modules/battle/content/battle-content.js";
import { buildBattle } from "../src/modules/battle/sim/battle-spec.js";
import { BattleContentError, MatchPhase } from "../src/modules/battle/sim/definitions.js";
import { applyExperience } from "../src/modules/profile/experience.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { createTestServices, TEST_CONTENT_PATH } from "./support/test-services.js";

const content = () => JSON.parse(readFileSync(TEST_CONTENT_PATH, "utf8"));

function victory(seconds = 2, baseHealth = 1, maxBaseHealth = 1): BattleOutcome {
  return { kind: "VICTORY", seconds, ticks: Math.round(seconds / 0.05), baseHealth, maxBaseHealth, kills: 1 };
}

async function guest(services: ReturnType<typeof createTestServices>, deviceId = "device-battle-0001") {
  const outcome = await services.auth.deviceLogin({ deviceId, platform: "test" });
  return outcome.userId;
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

describe("battle content", () => {
  it("loads the test campaign and resolves stages with the difficulty applied", () => {
    const catalog = BattleCatalog.fromFile(TEST_CONTENT_PATH);
    assert.equal(catalog.stages.length, 4);
    const spec = catalog.resolve(catalog.stage("test_2"));
    assert.equal(spec.seed, 7);
    assert.deepEqual(spec.cards.map((card) => card.id), ["shooter", "generator"]);
    assert.equal(spec.enemies[0].speed, 8 * 1.2000000476837158);
    assert.equal(spec.enemies[0].damage, 10);
    const random = catalog.resolve(catalog.stage("test_siege"));
    assert.ok(random.seed >= 1 && random.seed <= 0xffffffff, "encounters with seed 0 get a random seed per battle");
  });

  it("matches the C# difficulty formula", () => {
    const enemy = { id: "e", health: 100.5, speed: 0.3, damage: 7, attackInterval: 1, armor: 0, reward: 1, baseDamage: 1, reach: 0.6, phases: [{ healthFraction: 0.5, speedMultiplier: 1, damageMultiplier: 1, incomingDamageMultiplier: 1, pulseInterval: 1, pulseDamage: 3 }] };
    const scaled = applyDifficulty(enemy, { id: "x", enemyHealth: 1.1, enemySpeed: 0.9, enemyDamage: 1.3 });
    assert.equal(scaled.health, 100.5 * 1.1);
    assert.equal(scaled.phases[0].pulseDamage, 3 * 1.3);
  });

  it("rejects broken references, cycles and unbuildable stages at load time", () => {
    const unknownEnemy = content();
    unknownEnemy.encounters[0].waves[0].groups[0].enemy = "ghost";
    assert.throws(() => BattleCatalog.fromJson(unknownEnemy), BattleContentError);
    const cycle = content();
    cycle.stages[0].prerequisites = ["test_2"];
    assert.throws(() => BattleCatalog.fromJson(cycle), /cycle/);
    const unbuildable = content();
    unbuildable.encounters[0].settings.lanes = 0;
    assert.throws(() => BattleCatalog.fromJson(unbuildable), BattleContentError);
    const strict = content();
    strict.stages[0].reward = 1;
    assert.throws(() => BattleCatalog.fromJson(strict), BattleContentError);
  });

  it("runs the quick test stages to the expected ends", () => {
    const catalog = BattleCatalog.fromFile(TEST_CONTENT_PATH);
    for (const [stageId, phase] of [["test_1", MatchPhase.Victory], ["test_2", MatchPhase.Defeat]] as const) {
      const battle = buildBattle(catalog.resolve(catalog.stage(stageId)));
      while (!battle.isOver && battle.ticks < 200) battle.step();
      assert.equal(battle.phase, phase, stageId);
    }
  });
});

describe("experience", () => {
  it("levels up as many times as the experience allows", () => {
    assert.deepEqual(applyExperience(1, 90, 20), { level: 2, exp: 10, levelsGained: 1 });
    assert.deepEqual(applyExperience(1, 0, 100 + 150 + 5), { level: 3, exp: 5, levelsGained: 2 });
    assert.deepEqual(applyExperience(4, 3, 0), { level: 4, exp: 3, levelsGained: 0 });
  });
});

describe("battle service", () => {
  it("unlocks stages by prerequisites and level", async () => {
    const services = createTestServices();
    const userId = await guest(services);
    const before = await services.battles.campaign(userId);
    assert.deepEqual(before.stages.map((s) => [s.id, s.unlocked, s.stars]), [
      ["test_1", true, 0], ["test_2", false, 0], ["test_siege", true, 0], ["test_veteran", false, 0],
    ]);
    await rejects(services.battles.prepare(userId, "test_2"), "STAGE_LOCKED");
    await rejects(services.battles.prepare(userId, "test_veteran"), "STAGE_LOCKED");
    await rejects(services.battles.prepare(userId, "nowhere"), "STAGE_UNKNOWN");

    const battle = await services.battles.prepare(userId, "test_1");
    await services.battles.finish(battle, victory(), "hash");
    const after = await services.battles.campaign(userId);
    assert.deepEqual(after.stages.map((s) => [s.id, s.unlocked, s.stars, s.wins]), [
      ["test_1", true, 3, 1], ["test_2", true, 0, 0], ["test_siege", true, 0, 0], ["test_veteran", false, 0, 0],
    ]);
  });

  it("grants the first clear bonus once, stars by base health and time, and levels the player up", async () => {
    const services = createTestServices();
    const userId = await guest(services);

    const first = await services.battles.finish(await services.battles.prepare(userId, "test_1"), victory(), "hash");
    assert.equal(first.outcome, "VICTORY");
    assert.equal(first.stars, 3);
    assert.equal(first.firstClear, true);
    assert.deepEqual(first.reward, { currencies: { coins: 100, gems: 5 }, items: { "seeds.bomber": 6, plant_xp: 40 }, exp: 110 });
    assert.deepEqual(first.wallet, { coins: 100, gems: 5 });
    assert.equal(first.levelsGained, 1);
    assert.deepEqual([first.profile.level, first.profile.exp, first.profile.expToNext], [2, 10, 150]);

    const slow = await services.battles.finish(await services.battles.prepare(userId, "test_1"), victory(90, 1, 2), "hash");
    assert.equal(slow.stars, 1, "base damaged and over the time: one star");
    assert.equal(slow.bestStars, 3);
    assert.equal(slow.firstClear, false);
    assert.deepEqual(slow.reward, { currencies: { coins: 100 }, items: {}, exp: 60 });
    assert.deepEqual(slow.wallet, { coins: 200, gems: 5 });

    const ledger = services.store.ledger.filter((entry) => entry.userId === userId);
    assert.deepEqual(ledger.map((e) => [e.currencyId, e.delta, e.reason]), [["coins", 100, "STAGE_REWARD"], ["gems", 5, "STAGE_REWARD"], ["coins", 100, "STAGE_REWARD"]]);
    const progress = await services.battleRepository.getProgress(userId, "test_1", { kind: "db-session" });
    assert.equal(progress.wins, 2);
    assert.equal(progress.plays, 2);
    assert.equal(progress.bestTimeMs, 2000);
  });

  it("records a battle once: a second finish grants nothing", async () => {
    const services = createTestServices();
    const userId = await guest(services);
    const battle = await services.battles.prepare(userId, "test_1");
    await services.battles.finish(battle, victory(), "hash");
    await rejects(services.battles.finish(battle, victory(), "hash"), "BATTLE_ALREADY_FINISHED");
    assert.deepEqual(await services.wallets.snapshot(userId), { coins: 100, gems: 5 });
    assert.equal((await services.battleRepository.getProgress(userId, "test_1", { kind: "db-session" })).wins, 1);
  });

  it("gives defeats their small reward and abandoned battles nothing", async () => {
    const services = createTestServices();
    const userId = await guest(services);
    const defeat = await services.battles.finish(await services.battles.prepare(userId, "test_siege"),
      { kind: "DEFEAT", seconds: 30, ticks: 600, baseHealth: 0, maxBaseHealth: 3, kills: 0 }, "hash");
    assert.equal(defeat.stars, 0);
    assert.deepEqual(defeat.reward, { currencies: {}, items: {}, exp: 5 });
    const abandoned = await services.battles.finish(await services.battles.prepare(userId, "test_siege"),
      { kind: "ABANDONED", seconds: 3, ticks: 60, baseHealth: 3, maxBaseHealth: 3, kills: 0 }, "hash");
    assert.deepEqual(abandoned.reward, { currencies: {}, items: {}, exp: 0 });
    const progress = await services.battleRepository.getProgress(userId, "test_siege", { kind: "db-session" });
    assert.deepEqual([progress.plays, progress.wins, progress.bestStars], [2, 0, 0]);
    assert.equal(services.store.battleResults.size, 2);
  });
});
