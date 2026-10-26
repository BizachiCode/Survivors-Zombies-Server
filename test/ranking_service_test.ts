// Leaderboards on in-memory data: the three boards, tie-breaks, the 60 s cache, the player's own row and public ids.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

import { AppError } from "../src/shared/errors/app-error.js";
import { fixedClock } from "../src/shared/kernel/clock.js";
import { RankingService } from "../src/modules/ranking/ranking.service.js";
import { MemoryRankingRepository } from "./support/memory-ranking.js";
import { createTestServices, testClock } from "./support/test-services.js";

type Services = ReturnType<typeof createTestServices<ReturnType<typeof testClock>>>;

/** Signs a guest in, one minute after the previous one (account age is a tie-breaker), and names it. */
async function player(services: Services, name: string, setup: { level?: number; exp?: number; stars?: number[]; wins?: number; defeats?: number } = {}) {
  services.clock.set(services.clock.nowMs() + 60_000);
  const { userId } = await services.auth.deviceLogin({ deviceId: `device-rank-${name}`, platform: "test" });
  const profile = services.store.profiles.get(userId)!;
  Object.assign(profile, { nickname: name, level: setup.level ?? 1, exp: setup.exp ?? 0 });
  (setup.stars ?? []).forEach((bestStars, index) => {
    services.store.stageProgress.set(`${userId}:s${index}`, { userId, stageId: `s${index}`, bestStars, wins: 1, plays: 1, bestTimeMs: 1000, firstClearedAt: null });
  });
  const result = (outcome: "VICTORY" | "DEFEAT", index: number) => {
    const id = `${userId}-${outcome}-${index}`;
    services.store.battleResults.set(id, {
      id, userId, stageId: "s0", outcome, stars: 0, ticks: 1, kills: 0, baseHealth: 1, contentHash: "h", reward: { currencies: {}, items: {}, exp: 0 },
    } as any);
  };
  for (let i = 0; i < (setup.wins ?? 0); i++) result("VICTORY", i);
  for (let i = 0; i < (setup.defeats ?? 0); i++) result("DEFEAT", i);
  return userId;
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

describe("ranking", () => {
  let services: Services;
  let repository: MemoryRankingRepository;
  let rankings: RankingService;
  let clock: ReturnType<typeof fixedClock>;
  let ana: string, bruno: string, carla: string, dino: string, eva: string, newcomer: string;

  beforeEach(async () => {
    services = createTestServices({ clock: testClock() });
    ana = await player(services, "Ana", { level: 5, exp: 10, stars: [3, 3, 2], wins: 4, defeats: 3 });
    bruno = await player(services, "Bruno", { level: 7, exp: 0, stars: [3, 3, 2], wins: 4 });
    carla = await player(services, "Carla", { level: 7, exp: 90, stars: [1], wins: 9 });
    dino = await player(services, "Dino", { level: 2, stars: [3, 3, 3, 3], wins: 1 });
    eva = await player(services, "Eva", { level: 7, exp: 90 });
    newcomer = await player(services, "Nova");
    repository = new MemoryRankingRepository(services.store);
    clock = fixedClock(Date.UTC(2026, 9, 21, 12, 0, 0));
    rankings = new RankingService(repository, clock);
  });

  it("ranks stars by their sum, breaking ties by level then by the older account", async () => {
    const stars = await rankings.info(ana, "stars");
    assert.deepEqual(stars.top.map((e) => [e.rank, e.nickname, e.score]), [[1, "Dino", 12], [2, "Bruno", 8], [2, "Ana", 8], [4, "Carla", 1]]);
    assert.deepEqual(stars.me, { rank: 2, userId: ana.replace(/-/g, "").slice(0, 8).toUpperCase(), nickname: "Ana", avatarId: stars.me!.avatarId, level: 5, score: 8 });
    assert.equal(stars.board, "stars");
  });

  it("ranks the level board by level then experience and shows the level as the score", async () => {
    const levels = await rankings.info(dino, "level");
    assert.deepEqual(levels.top.map((e) => [e.rank, e.nickname, e.score]), [[1, "Carla", 7], [1, "Eva", 7], [3, "Bruno", 7], [4, "Ana", 5], [5, "Dino", 2], [6, "Nova", 1]]);
    assert.equal(levels.me!.rank, 5);
  });

  it("counts only victories on the wins board", async () => {
    const wins = await rankings.info(carla, "wins");
    assert.deepEqual(wins.top.map((e) => [e.rank, e.nickname, e.score]), [[1, "Carla", 9], [2, "Bruno", 4], [2, "Ana", 4], [4, "Dino", 1]]);
    assert.equal(wins.me!.rank, 1);
  });

  it("answers null for a player without a score and never exposes the full user id", async () => {
    const stars = await rankings.info(newcomer, "stars");
    assert.equal(stars.me, null);
    assert.equal((await rankings.info(eva, "wins")).me, null);
    assert.equal((await rankings.info(newcomer, "level")).me!.rank, 6, "everybody is on the level board");
    for (const entry of stars.top) {
      assert.match(entry.userId, /^[0-9A-F]{8}$/);
      assert.ok(![ana, bruno, carla, dino, eva].includes(entry.userId));
    }
  });

  it("finds the player's own rank outside the top", async () => {
    const small = new RankingService(repository, clock, { topSize: 2 });
    const stars = await small.info(carla, "stars");
    assert.equal(stars.top.length, 2);
    assert.deepEqual([stars.me!.rank, stars.me!.score], [4, 1]);
  });

  it("caches each board's top for 60 seconds but computes the own row per request", async () => {
    const first = await rankings.info(carla, "stars");
    assert.equal(first.me!.rank, 4);
    assert.equal(first.refreshedAtUnix, clock.nowUnix());
    services.store.stageProgress.set(`${carla}:more`, { userId: carla, stageId: "more", bestStars: 20, wins: 1, plays: 1, bestTimeMs: 1, firstClearedAt: null });

    clock.set(clock.nowMs() + 59_000);
    const cached = await rankings.info(carla, "stars");
    assert.equal(repository.topQueries, 1);
    assert.equal(cached.top[0].nickname, "Dino", "the cached top is unchanged");
    assert.deepEqual([cached.me!.rank, cached.me!.score], [1, 21], "the own row is live");
    assert.equal(cached.refreshedAtUnix, first.refreshedAtUnix);

    clock.set(clock.nowMs() + 2_000);
    const fresh = await rankings.info(carla, "stars");
    assert.equal(repository.topQueries, 2);
    assert.equal(fresh.top[0].nickname, "Carla");
    assert.equal(fresh.refreshedAtUnix, clock.nowUnix());

    await rankings.info(carla, "wins");
    assert.equal(repository.topQueries, 3, "boards are cached separately");
  });

  it("shares one query between concurrent requests", async () => {
    await Promise.all([rankings.info(ana, "level"), rankings.info(bruno, "level"), rankings.info(carla, "level")]);
    assert.equal(repository.topQueries, 1);
  });

  it("refuses unknown boards", async () => {
    await rejects(rankings.info(ana, "gold"), "RANKING_UNKNOWN_BOARD");
    await rejects(rankings.info(ana, ""), "RANKING_UNKNOWN_BOARD");
  });
});
