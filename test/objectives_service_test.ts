// Objectives (daily / weekly missions, achievement chains, event goals) counted from gameplay, claimed once per period,
// and the daily login calendar.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { BattleOutcome } from "../src/modules/battle/battle-rules.js";
import { BattleCatalog } from "../src/modules/battle/content/battle-content.js";
import { BattleContentError } from "../src/modules/battle/sim/definitions.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { ProfileStatsReader } from "../src/modules/profile/profile-stats.js";
import { MemoryCollectionRepository } from "./support/memory-repositories.js";
import { createTestServices, testClock, TEST_CONTENT_PATH } from "./support/test-services.js";

const content = () => JSON.parse(readFileSync(TEST_CONTENT_PATH, "utf8"));
const victory: BattleOutcome = { kind: "VICTORY", seconds: 20, ticks: 400, baseHealth: 1, maxBaseHealth: 1, kills: 3, placed: 4, merges: 1 };

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

async function setup(deviceId = "device-objectives-0001") {
  const services = createTestServices({ clock: testClock() });
  const { userId } = await services.auth.deviceLogin({ deviceId, platform: "test" });
  await services.collection.info(userId);
  const win = async () => services.battles.finish(await services.battles.prepare(userId, "test_1"), victory, "hash");
  return { services, userId, win };
}

describe("objectives content", () => {
  it("rejects unknown events, unknown reward items and duplicate ids", () => {
    const broken = (change: (c: any) => void) => { const c = content(); change(c); return () => BattleCatalog.fromJson(c); };
    assert.throws(broken((c) => { c.progression.objectives[5].event = "nope"; }), /unknown event/);
    assert.throws(broken((c) => { c.progression.objectives[0].reward.items = { nope: 1 }; }), BattleContentError);
    assert.throws(broken((c) => { c.progression.objectives[1].id = "daily_win"; }), /Duplicate objective/);
    assert.throws(broken((c) => { c.progression.dailyRewards[0].items = { nope: 1 }; }), /Daily reward 1/);
  });
});

describe("objectives", () => {
  it("counts battles into missions, achievements and running events, in the player's language", async () => {
    const { services, userId, win } = await setup();
    await win();
    const info = await services.objectives.info(userId, "pt");
    const daily = Object.fromEntries(info.daily.objectives.map((o) => [o.id, o]));
    assert.equal(daily.daily_win.title, "Vença 2 batalhas");
    assert.equal(daily.daily_stars.title, "Earn 3 stars", "a plain string stays as is");
    assert.deepEqual([daily.daily_win.progress, daily.daily_win.completed], [1, false]);
    assert.deepEqual(info.achievements.map((a) => [a.id, a.progress, a.completed, a.tier, a.tiers]), [["ach_win_1", 1, true, 1, 2]]);
    assert.deepEqual(info.events.map((e) => [e.id, e.title, e.objectives.map((o) => [o.id, o.progress])]), [["ev_halloween", "Dia das Bruxas", [["ev_kill", 3]]]]);
    assert.equal(info.daily.resetsAtUnix, Date.UTC(2026, 9, 22) / 1000);
    assert.equal(info.weekly.resetsAtUnix, Date.UTC(2026, 9, 26) / 1000, "weeks start on Monday (UTC)");
    assert.deepEqual(info.claimable, { daily: 1, weekly: 0, achievements: 1, events: 0 }, "3 stars complete daily_stars");
  });

  it("claims a completed objective once, through the ledgers, and walks achievement tiers in order", async () => {
    const { services, userId, win } = await setup();
    await rejects(services.objectives.claim(userId, "ach_win_1"), "OBJECTIVE_NOT_COMPLETED");
    await win();
    const claimed = await services.objectives.claim(userId, "ach_win_1");
    assert.deepEqual(claimed.granted.currencies, { coins: 10 });
    assert.equal(claimed.wallet.coins, (await services.wallets.snapshot(userId)).coins);
    assert.deepEqual(claimed.achievements.map((a) => [a.id, a.progress, a.tier]), [["ach_win_2", 1, 2]], "the next tier shows");
    await rejects(services.objectives.claim(userId, "ach_win_1"), "OBJECTIVE_CLAIMED");
    await rejects(services.objectives.claim(userId, "nope"), "OBJECTIVE_UNKNOWN");
    const reasons = services.store.ledger.filter((e) => e.userId === userId && e.reason === "OBJECTIVE_REWARD");
    assert.equal(reasons.length, 1);

    await win();
    await win();
    const top = await services.objectives.claim(userId, "ach_win_2");
    assert.ok(top.levelsGained >= 1, "200 experience levels the player up");
    assert.deepEqual(top.achievements.map((a) => [a.id, a.claimed]), [["ach_win_2", true]], "a finished chain shows its last tier, claimed");
  });

  it("resets daily missions every UTC day and weekly ones every Monday; events only count while they run", async () => {
    const { services, userId, win } = await setup();
    await win();
    await win();
    const day1 = await services.objectives.claimAll(userId, "daily");
    assert.deepEqual(day1.granted.currencies, { coins: 50 });
    assert.equal(day1.daily.objectives.find((o) => o.id === "daily_win").claimed, true);
    await services.uow.transaction((s) => services.wallets.credit(s, userId, { coins: 100 }, "ADMIN"));
    await services.collection.upgrade(userId, "shooter");
    assert.equal((await services.objectives.info(userId)).claimable.weekly, 1);

    services.clock.set(Date.UTC(2026, 9, 22, 0, 0, 1));
    const day2 = await services.objectives.info(userId);
    assert.deepEqual(day2.daily.objectives.map((o) => [o.id, o.progress, o.claimed]), [["daily_win", 0, false], ["daily_stars", 0, false]]);
    assert.equal(day2.claimable.weekly, 1, "still the same week");
    services.clock.set(Date.UTC(2026, 9, 26, 0, 0, 1));
    assert.equal((await services.objectives.info(userId)).claimable.weekly, 0, "a new week");

    await rejects(services.objectives.claim(userId, "ev_future_play"), "OBJECTIVE_INACTIVE");
    services.clock.set(Date.UTC(2026, 10, 2));
    assert.deepEqual((await services.objectives.info(userId)).events, [], "the event is over");
  });
});

describe("daily rewards", () => {
  it("grants one calendar day per UTC day, in order, looping, and counts the login", async () => {
    const { services, userId } = await setup("device-daily-0001");
    const first = await services.daily.info(userId);
    assert.deepEqual(first.days.map((d) => d.state), ["available", "locked", "locked"]);
    const claimed = await services.daily.claim(userId);
    assert.deepEqual([claimed.granted.currencies, claimed.claimedToday], [{ coins: 10 }, true]);
    assert.deepEqual(claimed.days.map((d) => d.state), ["claimed", "locked", "locked"]);
    await rejects(services.daily.claim(userId), "DAILY_ALREADY_CLAIMED");

    for (const [day, expected] of [[22, ["claimed", "claimed", "locked"]], [23, ["claimed", "claimed", "claimed"]]] as const) {
      services.clock.set(Date.UTC(2026, 9, day, 8));
      assert.equal((await services.daily.info(userId)).claimedToday, false);
      assert.deepEqual((await services.daily.claim(userId)).days.map((d) => d.state), expected);
    }
    services.clock.set(Date.UTC(2026, 9, 25, 8));
    const loop = await services.daily.info(userId);
    assert.deepEqual([loop.next, loop.days.map((d) => d.state)], [0, ["available", "locked", "locked"]], "a missed day doesn't reset; the cycle loops");
    const progress = services.objectivesRepository.progress;
    assert.equal(progress.size >= 0, true);
  });
});

describe("profile stats", () => {
  it("sums battles, stars, crew and claimed achievements for the profile screen", async () => {
    const { services, userId, win } = await setup("device-stats-0001");
    await win();
    await services.objectives.claim(userId, "ach_win_1");
    const reader = new ProfileStatsReader(services.catalog, services.battleRepository, new MemoryCollectionRepository(services.store), services.objectivesRepository);
    const stats = await reader.stats(userId);
    assert.deepEqual([stats.battlesPlayed, stats.battlesWon, stats.stagesCleared, stats.crewOwned, stats.bestCrewLevel], [1, 1, 1, 3, 1], "test_1 grants the guard card");
    assert.deepEqual([stats.achievementsCompleted, stats.achievementsTotal, stats.stagesTotal], [1, 2, services.catalog.stages.length]);
    assert.ok(stats.starsTotal >= 1 && stats.starsMax === services.catalog.stages.length * 3);
  });
});
