// Arena rules on in-memory repositories: content checks, seasons, tickets (spend, regenerate, buy), groups, matches
// played as authoritative battles of mode "arena" through BattleService, and the end-of-season settlement.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { arenaScore, seasonOf } from "../src/modules/arena/arena-content.js";
import { ArenaService, rankGroup, type ArenaMailer } from "../src/modules/arena/arena.service.js";
import type { BattleOutcome } from "../src/modules/battle/battle-rules.js";
import { BattleCatalog } from "../src/modules/battle/content/battle-content.js";
import { BattleContentError } from "../src/modules/battle/sim/definitions.js";
import type { MailDraft } from "../src/modules/mail/mail.service.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { MemoryArenaRepository } from "./support/memory-arena.js";
import { createTestServices, testClock, TEST_CONTENT_PATH } from "./support/test-services.js";

const HOUR = 3_600_000;

function content(change?: (arena: any) => void) {
  const c = JSON.parse(readFileSync(TEST_CONTENT_PATH, "utf8"));
  c.arena = {
    title: { en: "Arena", pt: "Arena" },
    encounter: "open_run",
    difficulty: "normal",
    scoring: { perKill: 10, perWave: 100, victoryBonus: 1000, perBaseHealth: 5 },
    tickets: { max: 2, regenMinutes: 60, price: { currency: "gems", amount: 5 } },
    groupSize: 2,
    leagues: [
      { id: "bronze", name: "Bronze", promote: 1, demote: 0, rewards: [{ toRank: 1, reward: { currencies: { gems: 10 } } }, { toRank: 2, reward: { currencies: { coins: 50 } } }] },
      { id: "silver", name: { en: "Silver", pt: "Prata" }, promote: 1, demote: 1, rewards: [{ toRank: 2, reward: { currencies: { gems: 20 } } }] },
      { id: "gold", name: "Gold", promote: 0, demote: 1, rewards: [] },
    ],
  };
  change?.(c.arena);
  return c;
}

function setup() {
  const catalog = BattleCatalog.fromJson(content());
  const services = createTestServices({ clock: testClock(), catalog });
  const repository = new MemoryArenaRepository(services.store);
  const mails: { userId: string; draft: MailDraft }[] = [];
  const mailer: ArenaMailer = { send: async (_session, userId, draft) => { mails.push({ userId, draft }); return `mail-${mails.length}`; } };
  const arena = new ArenaService(catalog, repository, services.wallets, mailer, services.uow, services.clock);
  services.battles.registerMode(arena.mode);
  return { ...services, arena, repository, mails };
}

async function player(services: ReturnType<typeof setup>, device: string, nickname: string) {
  const { userId } = await services.auth.deviceLogin({ deviceId: device, platform: "test" });
  services.store.profiles.get(userId)!.nickname = nickname;
  return userId;
}

/** Plays one arena match to `outcome` through BattleService (prepare = ticket, finish = score). */
async function play(services: ReturnType<typeof setup>, userId: string, outcome: Partial<BattleOutcome>) {
  const prepared = await services.battles.prepareMode(userId, "arena", "");
  return services.battles.finish(prepared, {
    kind: "DEFEAT", seconds: 30, ticks: 600, baseHealth: 0, maxBaseHealth: 10, kills: 0, waves: 0, ...outcome,
  }, "hash");
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

describe("arena", () => {
  it("validates the arena content", () => {
    assert.throws(() => BattleCatalog.fromJson(content((a) => { a.encounter = "nope"; })), BattleContentError);
    assert.throws(() => BattleCatalog.fromJson(content((a) => { a.leagues[1].promote = 2; })), /exceed the group size/);
    assert.throws(() => BattleCatalog.fromJson(content((a) => { a.leagues[0].rewards[1].toRank = 1; })), /must grow/);
    assert.throws(() => BattleCatalog.fromJson(content((a) => { a.leagues[0].id = "silver"; })), /duplicate league/);
  });

  it("counts seasons from Monday 00:00 UTC and scores runs", () => {
    assert.deepEqual(seasonOf(Date.UTC(2026, 9, 21, 12)).id, "2026-10-19");
    assert.deepEqual(seasonOf(Date.UTC(2026, 9, 19, 0, 0, 0)).id, "2026-10-19");
    assert.deepEqual(seasonOf(Date.UTC(2026, 9, 18, 23, 59, 59)).id, "2026-10-12");
    assert.equal(seasonOf(Date.UTC(2026, 9, 21)).endsAtMs, Date.UTC(2026, 9, 26));
    const scoring = { perKill: 10, perWave: 100, victoryBonus: 1000, perBaseHealth: 5 };
    assert.equal(arenaScore(scoring, { victory: false, kills: 7, waves: 2, baseHealth: 0 }), 270);
    assert.equal(arenaScore(scoring, { victory: true, kills: 7, waves: 2, baseHealth: 4 }), 270 + 1000 + 20);
  });

  it("spends tickets on matches, regenerates them and sells more", async () => {
    const services = setup();
    const ana = await player(services, "device-arena-ana", "Ana");
    const info = await services.arena.info(ana, "pt");
    assert.deepEqual([info.enabled, info.tickets, info.maxTickets, info.joined, info.league!.id, info.leagues[1].name], [true, 2, 2, false, "bronze", "Prata"]);

    await play(services, ana, { kills: 1 });
    await play(services, ana, { kills: 1 });
    const empty = await services.arena.info(ana);
    assert.deepEqual([empty.tickets, empty.nextTicketAtUnix], [0, (Date.UTC(2026, 9, 21, 12) + HOUR) / 1000]);
    await rejects(services.battles.prepareMode(ana, "arena", ""), "ARENA_NO_TICKETS");

    services.clock.set(Date.UTC(2026, 9, 21, 13, 30));
    assert.equal((await services.arena.info(ana)).tickets, 1, "one ticket per hour");
    services.clock.set(Date.UTC(2026, 9, 21, 20));
    assert.equal((await services.arena.info(ana)).tickets, 2, "never beyond the maximum");

    await rejects(services.arena.buyTicket(ana), "WALLET_INSUFFICIENT_FUNDS");
    await services.uow.transaction((s) => services.wallets.credit(s, ana, { gems: 7 }, "ADMIN"));
    const bought = await services.arena.buyTicket(ana);
    assert.deepEqual([bought.tickets, bought.wallet!.gems], [3, 2], "bought tickets go beyond the maximum");
  });

  it("scores matches, keeps the best and ranks the group", async () => {
    const services = setup();
    const ana = await player(services, "device-arena-ana", "Ana");
    const bruno = await player(services, "device-arena-bruno", "Bruno");
    const carla = await player(services, "device-arena-carla", "Carla");

    const first = await play(services, ana, { kills: 5, waves: 1 });
    assert.deepEqual(first.arena, { seasonId: "2026-10-19", score: 150, bestScore: 150, newBest: true, rank: 1, groupSize: 1, league: "bronze" });
    assert.deepEqual([first.stars, first.reward], [0, { currencies: {}, items: {}, exp: 0 }], "arena matches grant nothing directly");
    services.clock.set(Date.UTC(2026, 9, 21, 12, 5));
    const worse = await play(services, ana, { kills: 1 });
    assert.deepEqual([(worse.arena as any).score, (worse.arena as any).bestScore, (worse.arena as any).newBest], [10, 150, false]);

    const win = await play(services, bruno, { kind: "VICTORY", kills: 3, waves: 1, baseHealth: 10 });
    assert.deepEqual([(win.arena as any).score, (win.arena as any).rank, (win.arena as any).groupSize], [30 + 100 + 1000 + 50, 1, 2]);

    await play(services, carla, { kills: 1 });
    assert.equal(services.repository.groups.length, 2, "groups hold groupSize players");

    const view = await services.arena.info(ana);
    assert.deepEqual(view.group.map((e) => [e.rank, e.nickname, e.score, e.me]), [[1, "Bruno", 1180, false], [2, "Ana", 150, true]]);
    assert.deepEqual([view.rank, view.bestScore, view.plays, view.joined], [2, 150, 2, true]);
    assert.equal(view.group[0].code, bruno.slice(0, 8).toUpperCase());

    const abandoned = await play(services, carla, { kind: "ABANDONED", kills: 50, waves: 3 });
    assert.equal((abandoned.arena as any).score, 0, "an abandoned match scores nothing");
  });

  it("ranks ties by who reached the score first", () => {
    const at = (ms: number) => new Date(ms);
    const base = { seasonId: "s", groupId: "g", leagueIndex: 0, plays: 1, settledAt: null as Date | null, nickname: "", avatarId: "", level: 1 };
    const ranked = rankGroup([
      { ...base, userId: "b", bestScore: 100, bestAt: at(2) },
      { ...base, userId: "a", bestScore: 100, bestAt: at(1) },
      { ...base, userId: "c", bestScore: 0, bestAt: null },
      { ...base, userId: "d", bestScore: 300, bestAt: at(5) },
    ]);
    assert.deepEqual(ranked.map((r) => [r.userId, r.rank]), [["d", 1], ["a", 2], ["b", 3], ["c", 4]]);
  });

  it("settles the season once: promotion, demotion and the reward by mail", async () => {
    const services = setup();
    const ana = await player(services, "device-arena-ana", "Ana");
    const bruno = await player(services, "device-arena-bruno", "Bruno");
    await play(services, ana, { kills: 9 });
    await play(services, bruno, { kills: 2 });

    services.clock.set(Date.UTC(2026, 9, 27, 9));
    const anaNext = await services.arena.info(ana, "pt");
    assert.deepEqual(anaNext.lastSeason, {
      seasonId: "2026-10-19", rank: 1, groupSize: 2, reward: { currencies: { gems: 10 }, items: {}, exp: 0 },
      leagueBefore: { id: "bronze", name: "Bronze" }, leagueAfter: { id: "silver", name: "Prata" }, change: "promoted",
    });
    assert.deepEqual([anaNext.seasonId, anaNext.joined, anaNext.league!.id], ["2026-10-26", false, "silver"]);
    assert.equal((await services.arena.info(ana)).lastSeason, null, "shown once");
    const brunoNext = await services.arena.info(bruno);
    assert.deepEqual([brunoNext.lastSeason!.change, brunoNext.league!.id], ["stayed", "bronze"], "bronze has no demotion");

    assert.deepEqual(services.mails.map((m) => [m.userId, m.draft.attachments]), [
      [ana, { currencies: { gems: 10 }, items: {}, exp: 0 }], [bruno, { currencies: { coins: 50 }, items: {}, exp: 0 }],
    ]);
    assert.match(String((services.mails[0].draft.body as any).pt), /1º/);

    // Season 2 in silver: Ana loses to Carla (also silver) and goes back down.
    const carla = await player(services, "device-arena-carla", "Carla");
    services.repository.players.set(carla, { userId: carla, leagueIndex: 1, tickets: 2, ticketsAt: new Date(services.clock.nowMs()) });
    const anaMatch = await play(services, ana, { kills: 1 });
    assert.equal((anaMatch.arena as any).league, "silver");
    await play(services, carla, { kills: 3 });
    services.clock.set(Date.UTC(2026, 10, 3, 9));
    const after = await services.arena.info(ana);
    assert.deepEqual([after.lastSeason!.rank, after.lastSeason!.change, after.league!.id], [2, "demoted", "bronze"]);
    assert.equal((await services.arena.info(carla)).league!.id, "gold");
  });

  it("is disabled without arena content", async () => {
    const services = createTestServices({ clock: testClock() });
    const arena = new ArenaService(services.catalog, new MemoryArenaRepository(services.store), services.wallets, { send: async () => "" }, services.uow, services.clock);
    services.battles.registerMode(arena.mode);
    const userId = (await services.auth.deviceLogin({ deviceId: "device-arena-off", platform: "test" })).userId;
    assert.equal((await arena.info(userId)).enabled, false);
    await rejects(services.battles.prepareMode(userId, "arena", ""), "ARENA_DISABLED");
    await rejects(services.battles.prepareMode(userId, "nope", ""), "BATTLE_MODE_UNKNOWN");
  });
});
