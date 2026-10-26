// Clans on in-memory repositories: create (cost, unique name / tag), join types, level gate, full clans, requests, roles,
// kick / promote / demote, leadership transfer, the last member deleting the clan, search, the ranking by stars and token
// donations (limits, ledgers, rewards).
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

import { AppError } from "../src/shared/errors/app-error.js";
import { publicUserId } from "../src/shared/kernel/public-id.js";
import { CLANS_CONFIG, type ClansConfig } from "../src/modules/clans/clans-config.js";
import { ClansService, normalizeClanTag, type ClanChatPort } from "../src/modules/clans/clans.service.js";
import { MemoryClansRepository } from "./support/memory-clans.js";
import { MemoryCollectionRepository } from "./support/memory-repositories.js";
import { createTestServices, testClock } from "./support/test-services.js";

const HOUR_MS = 3_600_000;

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

type Config = Omit<Partial<ClansConfig>, "donation"> & { donation?: Partial<ClansConfig["donation"]> };

function setup(config: Config = {}, generateTag?: () => string) {
  const services = createTestServices({ clock: testClock(), startingBalances: { coins: 5000 } });
  const repository = new MemoryClansRepository(services.store);
  const chatCalls: string[] = [];
  const chat: ClanChatPort = {
    announce: (clanId, text) => { chatCalls.push(`announce ${text}`); void clanId; },
    evict: (clanId, userId) => { chatCalls.push(`evict ${publicUserId(userId)}`); void clanId; },
    close: () => { chatCalls.push("close"); },
  };
  const merged: ClansConfig = { ...CLANS_CONFIG, ...config, donation: { ...CLANS_CONFIG.donation, ...config.donation } };
  const clans = new ClansService(repository, services.profileRepository, services.wallets, services.inventory, new MemoryCollectionRepository(services.store),
    services.catalog, chat, services.uow, services.clock, merged, generateTag);
  let counter = 0;
  const newPlayer = async (nickname?: string, level = 1) => {
    counter++;
    const { userId } = await services.auth.deviceLogin({ deviceId: `device-clans-${String(counter).padStart(4, "0")}`, platform: "test" });
    if (nickname) services.store.profiles.get(userId)!.nickname = nickname;
    services.store.profiles.get(userId)!.level = level;
    return { userId, code: publicUserId(userId) };
  };
  const found = async (leader: { userId: string }, name = "Sea Wolves", overrides: Partial<{ description: string; badge: string; type: "open" | "request" | "closed"; minLevel: number }> = {}) => {
    const created = await clans.create(leader.userId, { name, description: "We sail.", badge: "badge_03", type: "open", minLevel: 0, ...overrides });
    return created.clan!;
  };
  const advance = (ms: number) => services.clock.set(services.clock.nowMs() + ms);
  const giveCard = (userId: string, cardId: string) => services.store.cards.set(`${userId}:${cardId}`, { userId, cardId, level: 1, source: "admin" });
  const giveItems = (userId: string, itemId: string, amount: number) => services.store.items.set(`${userId}:${itemId}`, amount);
  const coins = async (userId: string) => (await services.wallets.snapshot(userId)).coins;
  const tokens = async (userId: string) => (await services.inventory.snapshot(userId))["seeds.bomber"] ?? 0;
  return { ...services, repository, clans, chatCalls, newPlayer, found, advance, giveCard, giveItems, coins, tokens };
}

describe("clans", () => {
  describe("create", () => {
    it("charges the cost, makes me leader and gives the clan a unique tag", async () => {
      const { clans, newPlayer, coins, store } = setup();
      const ana = await newPlayer("Ana");
      const created = await clans.create(ana.userId, { name: "Sea Wolves", description: "  We   sail.  ", badge: "badge_03", type: "request", minLevel: 5 });
      const clan = created.clan!;
      assert.match(clan.tag, /^[0-9A-HJKMNP-TV-Z]{6}$/);
      assert.deepEqual([clan.name, clan.description, clan.badge, clan.type, clan.minLevel, clan.members, clan.maxMembers, clan.myRole],
        ["Sea Wolves", "We sail.", "badge_03", "request", 5, 1, 30, "leader"]);
      assert.deepEqual(clan.roster.map((m) => [m.code, m.nickname, m.role]), [[ana.code, "Ana", "leader"]]);
      assert.equal(clan.channel, `clan:${clan.id}`);
      assert.equal(clan.rank, 1);
      assert.equal(created.wallet.coins, 4000);
      assert.equal(await coins(ana.userId), 4000);
      assert.ok(store.ledger.some((entry) => entry.userId === ana.userId && entry.reason === "CLAN_CREATE" && entry.delta === -1000));
      assert.equal(created.limits.createCostCoins, 1000);
      assert.equal((await clans.info(ana.userId)).clan!.tag, clan.tag);
    });

    it("keeps names unique ignoring case, and retries a colliding tag", async () => {
      const tags = ["AAAAAA", "AAAAAA", "BBBBBB"];
      const { clans, newPlayer, found } = setup({}, () => tags.shift() ?? "CCCCCC");
      const ana = await newPlayer("Ana");
      const bruno = await newPlayer("Bruno");
      const carla = await newPlayer("Carla");
      assert.equal((await found(ana, "Sea Wolves")).tag, "AAAAAA");
      await rejects(found(bruno, "sea WOLVES"), "CLAN_NAME_TAKEN");
      assert.equal((await found(bruno, "Dock Rats")).tag, "BBBBBB");
      await rejects(clans.create(carla.userId, { name: "Dock Rats", description: "", badge: "badge_01", type: "open", minLevel: 0 }), "CLAN_NAME_TAKEN");
    });

    it("rejects a short wallet without leaving a clan behind", async () => {
      const { clans, newPlayer, repository, wallets, uow } = setup();
      const ana = await newPlayer("Ana");
      await uow.transaction((session) => wallets.debit(session, ana.userId, { coins: 4500 }, "ADMIN"));
      await rejects(clans.create(ana.userId, { name: "Poor Crew", description: "", badge: "badge_01", type: "open", minLevel: 0 }), "WALLET_INSUFFICIENT_FUNDS");
      assert.equal(repository.clans.size, 0);
      assert.equal((await clans.info(ana.userId)).clan, null);
    });

    it("validates the name, the settings and double membership", async () => {
      const { clans, newPlayer, found } = setup();
      const ana = await newPlayer("Ana");
      for (const name of ["ab", "x".repeat(21), "bad name!", "two  spaces", "Admin Squad", "tab\tname", "   "]) {
        await rejects(clans.create(ana.userId, { name, description: "", badge: "badge_01", type: "open", minLevel: 0 }), "CLAN_NAME_INVALID");
      }
      await rejects(clans.create(ana.userId, { name: "Fine", description: "", badge: "badge_99", type: "open", minLevel: 0 }), "INVALID_PAYLOAD");
      await rejects(clans.create(ana.userId, { name: "Fine", description: "", badge: "badge_01", type: "open", minLevel: 101 }), "INVALID_PAYLOAD");
      await rejects(clans.create(ana.userId, { name: "Fine", description: "d".repeat(141), badge: "badge_01", type: "open", minLevel: 0 }), "INVALID_PAYLOAD");
      await found(ana);
      await rejects(found(ana, "Another"), "CLAN_ALREADY_MEMBER");
    });
  });

  describe("joining", () => {
    it("lets anyone into an open clan and refuses a second clan", async () => {
      const { clans, newPlayer, found, chatCalls } = setup();
      const ana = await newPlayer("Ana");
      const bruno = await newPlayer("Bruno");
      const clan = await found(ana);
      const joined = await clans.join(bruno.userId, ` #${clan.tag.toLowerCase()} `);
      assert.deepEqual([joined.clan!.members, joined.clan!.myRole], [2, "member"]);
      assert.deepEqual((await clans.info(ana.userId)).clan!.roster.map((m) => m.nickname).sort(), ["Ana", "Bruno"]);
      await rejects(clans.join(bruno.userId, clan.tag), "CLAN_ALREADY_MEMBER");
      assert.ok(chatCalls.includes("announce Bruno joined the clan."));
      await rejects(clans.join((await newPlayer()).userId, "ZZZZZZ"), "CLAN_NOT_FOUND");
      await rejects(clans.join((await newPlayer()).userId, "not a tag"), "CLAN_NOT_FOUND");
    });

    it("applies the closed type and the level gate", async () => {
      const { clans, newPlayer, found } = setup();
      const ana = await newPlayer("Ana");
      const low = await newPlayer("Low", 3);
      const high = await newPlayer("High", 10);
      const closed = await found(ana, "Closed Crew", { type: "closed" });
      await rejects(clans.join(high.userId, closed.tag), "CLAN_CLOSED");
      await clans.edit(ana.userId, { description: "", badge: "badge_01", type: "open", minLevel: 5 });
      await assert.rejects(clans.join(low.userId, closed.tag), (error: unknown) =>
        error instanceof AppError && error.errorCode === "CLAN_LEVEL_TOO_LOW" && (error.extra as { minLevel: number }).minLevel === 5);
      assert.equal((await clans.join(high.userId, closed.tag)).clan!.members, 2);
    });

    it("refuses a full clan (also for requests)", async () => {
      const { clans, newPlayer, found } = setup({ maxMembers: 2 });
      const [ana, bruno, carla, dani] = [await newPlayer("Ana"), await newPlayer("Bruno"), await newPlayer("Carla"), await newPlayer("Dani")];
      const open = await found(ana, "Tiny Open");
      await clans.join(bruno.userId, open.tag);
      await assert.rejects(clans.join(carla.userId, open.tag), (error: unknown) =>
        error instanceof AppError && error.errorCode === "CLAN_FULL" && (error.extra as { max: number }).max === 2);
      const request = await found(carla, "Tiny Request", { type: "request" });
      await clans.join(dani.userId, request.tag);
      assert.equal((await clans.info(carla.userId)).clan!.requests.length, 1);
    });

    it("handles join requests: ask, cancel, accept, decline", async () => {
      const { clans, newPlayer, found, advance } = setup({ maxMembers: 3 });
      const ana = await newPlayer("Ana");
      const bruno = await newPlayer("Bruno");
      const carla = await newPlayer("Carla");
      const dani = await newPlayer("Dani");
      const clan = await found(ana, "Gate Keepers", { type: "request" });

      const asked = await clans.join(bruno.userId, clan.tag);
      assert.equal(asked.clan, null);
      assert.deepEqual([asked.pendingRequest!.tag, asked.pendingRequest!.name], [clan.tag, "Gate Keepers"]);
      await rejects(clans.join(bruno.userId, clan.tag), "CLAN_REQUEST_PENDING");
      const other = await found(dani, "Other Gate", { type: "request" });
      await rejects(clans.join(bruno.userId, other.tag), "CLAN_REQUEST_PENDING");

      const seen = (await clans.info(ana.userId)).clan!;
      assert.deepEqual(seen.requests.map((r) => [r.code, r.nickname]), [[bruno.code, "Bruno"]]);

      assert.equal((await clans.cancelRequest(bruno.userId)).pendingRequest, null);
      await rejects(clans.cancelRequest(bruno.userId), "CLAN_REQUEST_UNKNOWN");
      assert.equal((await clans.info(ana.userId)).clan!.requests.length, 0);

      advance(1000);
      await clans.join(bruno.userId, clan.tag);
      await clans.join(carla.userId, clan.tag);
      await rejects(clans.accept(bruno.userId, carla.code), "CLAN_NOT_MEMBER");
      const declined = await clans.decline(ana.userId, carla.code);
      assert.deepEqual(declined.clan!.requests.map((r) => r.nickname), ["Bruno"]);
      await rejects(clans.decline(ana.userId, carla.code), "CLAN_REQUEST_UNKNOWN");
      const accepted = await clans.accept(ana.userId, bruno.code);
      assert.deepEqual([accepted.clan!.members, accepted.clan!.requests.length], [2, 0]);
      assert.equal((await clans.info(bruno.userId)).clan!.name, "Gate Keepers");
      await rejects(clans.accept(ana.userId, bruno.code), "CLAN_REQUEST_UNKNOWN");
    });

    it("ignores requests older than the TTL and lets members manage requests only if they lead", async () => {
      const { clans, newPlayer, found, advance } = setup();
      const ana = await newPlayer("Ana");
      const bruno = await newPlayer("Bruno");
      const carla = await newPlayer("Carla");
      const clan = await found(ana, "Gate Keepers", { type: "request" });
      await clans.join(bruno.userId, clan.tag);
      advance(8 * 24 * HOUR_MS);
      assert.equal((await clans.info(ana.userId)).clan!.requests.length, 0);
      await rejects(clans.accept(ana.userId, bruno.code), "CLAN_REQUEST_UNKNOWN");
      // an expired request is replaced by asking again
      assert.equal((await clans.join(bruno.userId, clan.tag)).pendingRequest!.tag, clan.tag);

      await clans.edit(ana.userId, { description: "", badge: "badge_01", type: "open", minLevel: 0 });
      await clans.join(carla.userId, clan.tag);
      await rejects(clans.accept(carla.userId, bruno.code), "CLAN_FORBIDDEN");
      await rejects(clans.decline(carla.userId, bruno.code), "CLAN_FORBIDDEN");
    });
  });

  describe("roles", () => {
    async function crew() {
      const context = setup();
      const ana = await context.newPlayer("Ana");
      const clan = await context.found(ana);
      const members: Array<{ userId: string; code: string }> = [];
      for (const nickname of ["Bruno", "Carla", "Dani"]) {
        const player = await context.newPlayer(nickname);
        context.advance(1000);
        await context.clans.join(player.userId, clan.tag);
        members.push(player);
      }
      return { ...context, ana, clan, bruno: members[0]!, carla: members[1]!, dani: members[2]! };
    }

    it("promotes to co-leader, demotes, and only the leader may", async () => {
      const { clans, ana, bruno, carla, chatCalls } = await crew();
      const promoted = await clans.promote(ana.userId, bruno.code);
      assert.equal(promoted.clan!.roster.find((m) => m.code === bruno.code)!.role, "co_leader");
      assert.equal(promoted.clan!.roster[1]!.nickname, "Bruno", "roster order: leader, co-leaders, members");
      assert.ok(chatCalls.includes("announce Bruno was promoted to co-leader."));
      await rejects(clans.promote(bruno.userId, carla.code), "CLAN_FORBIDDEN");
      await rejects(clans.demote(bruno.userId, bruno.code), "CLAN_FORBIDDEN");
      await rejects(clans.promote(ana.userId, ana.code), "CLAN_FORBIDDEN");
      await rejects(clans.demote(ana.userId, carla.code), "CLAN_FORBIDDEN");
      await rejects(clans.promote(ana.userId, "00000000"), "CLAN_NOT_MEMBER");
      const demoted = await clans.demote(ana.userId, bruno.code);
      assert.equal(demoted.clan!.roster.find((m) => m.code === bruno.code)!.role, "member");
    });

    it("hands the leadership over by promoting a co-leader", async () => {
      const { clans, ana, bruno } = await crew();
      await clans.promote(ana.userId, bruno.code);
      const handed = await clans.promote(ana.userId, bruno.code);
      assert.equal(handed.clan!.myRole, "co_leader");
      const view = (await clans.info(bruno.userId)).clan!;
      assert.deepEqual([view.myRole, view.roster.find((m) => m.code === ana.code)!.role], ["leader", "co_leader"]);
    });

    it("lets the leader kick anyone and a co-leader kick members only", async () => {
      const { clans, ana, bruno, carla, dani, chatCalls } = await crew();
      await clans.promote(ana.userId, bruno.code);
      await rejects(clans.kick(carla.userId, dani.code), "CLAN_FORBIDDEN");
      await rejects(clans.kick(bruno.userId, ana.code), "CLAN_FORBIDDEN");
      await rejects(clans.kick(bruno.userId, bruno.code), "CLAN_FORBIDDEN");
      const kicked = await clans.kick(bruno.userId, carla.code);
      assert.equal(kicked.clan!.members, 3);
      assert.equal((await clans.info(carla.userId)).clan, null);
      assert.ok(chatCalls.includes(`evict ${carla.code}`));
      await clans.promote(ana.userId, dani.code);
      await rejects(clans.kick(bruno.userId, dani.code), "CLAN_FORBIDDEN");
      await clans.kick(ana.userId, dani.code);
      await clans.kick(ana.userId, bruno.code);
      assert.equal((await clans.info(ana.userId)).clan!.members, 1);
      await rejects(clans.kick(ana.userId, carla.code), "CLAN_NOT_MEMBER");
    });

    it("lets leaders and co-leaders edit the settings, not the name or plain members", async () => {
      const { clans, ana, bruno, carla, newPlayer } = await crew();
      await clans.promote(ana.userId, bruno.code);
      const edited = await clans.edit(bruno.userId, { description: "New motto", badge: "badge_12", type: "closed", minLevel: 7 });
      assert.deepEqual([edited.clan!.name, edited.clan!.description, edited.clan!.badge, edited.clan!.type, edited.clan!.minLevel],
        ["Sea Wolves", "New motto", "badge_12", "closed", 7]);
      await rejects(clans.edit(carla.userId, { description: "", badge: "badge_01", type: "open", minLevel: 0 }), "CLAN_FORBIDDEN");
      await rejects(clans.edit(ana.userId, { description: "", badge: "nope", type: "open", minLevel: 0 }), "INVALID_PAYLOAD");
      await rejects(clans.edit((await newPlayer("Outsider")).userId, { description: "", badge: "badge_01", type: "open", minLevel: 0 }), "CLAN_NOT_MEMBER");
    });
  });

  describe("leaving", () => {
    it("passes the leadership to the oldest co-leader, else the oldest member", async () => {
      const { clans, newPlayer, found, advance, chatCalls } = setup();
      const ana = await newPlayer("Ana");
      const clan = await found(ana);
      const joiners = [];
      for (const nickname of ["Bruno", "Carla", "Dani"]) {
        const player = await newPlayer(nickname);
        advance(1000);
        await clans.join(player.userId, clan.tag);
        joiners.push(player);
      }
      const [bruno, carla, dani] = joiners as [typeof ana, typeof ana, typeof ana];
      await clans.promote(ana.userId, dani.code);
      await clans.promote(ana.userId, carla.code);
      const left = await clans.leave(ana.userId);
      assert.equal(left.clan, null);
      const view = (await clans.info(bruno.userId)).clan!;
      assert.deepEqual(view.roster.map((m) => [m.nickname, m.role]), [["Carla", "leader"], ["Dani", "co_leader"], ["Bruno", "member"]], "Carla joined before Dani");
      assert.ok(chatCalls.includes("announce Carla is the new leader."));
      assert.ok(chatCalls.includes(`evict ${ana.code}`));

      await clans.leave(carla.userId);
      await clans.leave(dani.userId);
      const last = (await clans.info(bruno.userId)).clan!;
      assert.deepEqual([last.members, last.myRole], [1, "leader"], "with no co-leader the oldest member leads");
      await rejects(clans.leave(ana.userId), "CLAN_NOT_MEMBER");
    });

    it("hands over to the oldest member when there is no co-leader", async () => {
      const { clans, newPlayer, found, advance } = setup();
      const ana = await newPlayer("Ana");
      const clan = await found(ana);
      const bruno = await newPlayer("Bruno");
      advance(1000);
      await clans.join(bruno.userId, clan.tag);
      const carla = await newPlayer("Carla");
      advance(1000);
      await clans.join(carla.userId, clan.tag);
      await clans.leave(ana.userId);
      assert.equal((await clans.info(bruno.userId)).clan!.myRole, "leader");
      assert.equal((await clans.info(carla.userId)).clan!.myRole, "member");
    });

    it("deletes the clan when the last member leaves and frees the name", async () => {
      const { clans, newPlayer, found, repository, chatCalls } = setup();
      const ana = await newPlayer("Ana");
      const bruno = await newPlayer("Bruno");
      const clan = await found(ana);
      await clans.leave(ana.userId);
      assert.equal(repository.clans.size, 0);
      assert.ok(chatCalls.includes("close"));
      await rejects(clans.join(bruno.userId, clan.tag), "CLAN_NOT_FOUND");
      assert.equal((await found(bruno)).name, "Sea Wolves");
    });
  });

  describe("search and view", () => {
    it("finds open and request clans by name prefix or exact tag, never closed ones", async () => {
      const { clans, newPlayer, found } = setup();
      const players = [await newPlayer("A1"), await newPlayer("A2"), await newPlayer("A3"), await newPlayer("A4"), await newPlayer("Seeker")];
      const wolves = await found(players[0]!, "Sea Wolves");
      await found(players[1]!, "Sea Rats", { type: "request", minLevel: 4 });
      await found(players[2]!, "Sea Secret", { type: "closed" });
      await found(players[3]!, "Dock Rats");
      const seeker = players[4]!;

      const byName = await clans.search(seeker.userId, "sea");
      assert.deepEqual(byName.clans.map((c) => c.name), ["Sea Rats", "Sea Wolves"]);
      assert.deepEqual(byName.clans[0], { tag: byName.clans[0]!.tag, name: "Sea Rats", description: "We sail.", badge: "badge_03", type: "request", minLevel: 4, members: 1, maxMembers: 30, score: 0 });
      assert.deepEqual((await clans.search(seeker.userId, wolves.tag.toLowerCase())).clans.map((c) => c.name), ["Sea Wolves"]);
      assert.deepEqual((await clans.search(seeker.userId, "zzz")).clans, []);
      assert.equal(normalizeClanTag("#q x"), null);
    });

    it("recommends joinable clans the player's level allows, fullest first, and shows public cards", async () => {
      const { clans, newPlayer, found, advance } = setup({ maxMembers: 3 });
      const [a, b, c, d, e] = [await newPlayer("A"), await newPlayer("B"), await newPlayer("C"), await newPlayer("D"), await newPlayer("E")];
      const small = await found(a, "Small One");
      advance(1000);
      const big = await found(b, "Big One");
      await clans.join(c.userId, big.tag);
      advance(1000);
      await found(d, "High Level", { minLevel: 50 });
      const seeker = await newPlayer("Seeker", 2);
      const info = await clans.info(seeker.userId);
      assert.equal(info.clan, null);
      assert.deepEqual(info.recommended.map((r) => r.name), ["Big One", "Small One"]);
      await clans.join(e.userId, big.tag);
      assert.deepEqual((await clans.info(seeker.userId)).recommended.map((r) => r.name), ["Small One"], "full clans are not recommended");

      const card = (await clans.view(seeker.userId, big.tag)).clan;
      assert.deepEqual([card.name, card.members, card.rank], ["Big One", 3, 1]);
      assert.deepEqual(card.roster.map((m) => m.nickname), ["B", "C", "E"]);
      await rejects(clans.view(seeker.userId, "ZZZZZZ"), "CLAN_NOT_FOUND");
      assert.equal(small.members, 1);
    });
  });

  describe("ranking", () => {
    it("scores clans by the stars of their members and ranks them (ties share a rank)", async () => {
      const { clans, newPlayer, found, store, clock } = setup();
      const ana = await newPlayer("Ana");
      const bruno = await newPlayer("Bruno");
      const carla = await newPlayer("Carla");
      const dani = await newPlayer("Dani");
      const wolves = await found(ana, "Sea Wolves");
      const rats = await found(carla, "Dock Rats");
      await found(dani, "No Stars");
      await clans.join(bruno.userId, wolves.tag);
      const stars = (userId: string, stageId: string, bestStars: number) =>
        store.stageProgress.set(`${userId}:${stageId}`, { userId, stageId, bestStars, wins: 1, plays: 1, bestTimeMs: 1, firstClearedAt: null });
      stars(ana.userId, "s0", 3);
      stars(bruno.userId, "s0", 2);
      stars(bruno.userId, "s1", 1);
      stars(carla.userId, "s0", 6);

      const ranking = await clans.ranking(bruno.userId);
      assert.deepEqual(ranking.top.map((c) => [c.rank, c.name, c.score, c.members]), [[1, "Sea Wolves", 6, 2], [1, "Dock Rats", 6, 1], [3, "No Stars", 0, 1]]);
      assert.deepEqual([ranking.me!.name, ranking.me!.rank, ranking.me!.score], ["Sea Wolves", 1, 6]);
      const mine = (await clans.info(bruno.userId)).clan!;
      assert.deepEqual([mine.score, mine.rank], [6, 1]);
      assert.deepEqual(mine.roster.map((m) => [m.nickname, m.stars]), [["Ana", 3], ["Bruno", 3]]);
      assert.equal((await clans.ranking((await newPlayer("Loner")).userId)).me, null);
      assert.equal(rats.members, 1);
      void clock;
    });

    it("caches the top for a minute", async () => {
      const { clans, newPlayer, found, repository, advance } = setup();
      const ana = await newPlayer("Ana");
      await found(ana);
      await clans.ranking(ana.userId);
      await clans.ranking(ana.userId);
      assert.equal(repository.topQueries, 1);
      advance(61_000);
      await clans.ranking(ana.userId);
      assert.equal(repository.topQueries, 2);
    });
  });

  describe("donations", () => {
    async function donors(config: Config = {}) {
      const context = setup(config);
      const ana = await context.newPlayer("Ana");
      const clan = await context.found(ana);
      const bruno = await context.newPlayer("Bruno");
      const carla = await context.newPlayer("Carla");
      await context.clans.join(bruno.userId, clan.tag);
      await context.clans.join(carla.userId, clan.tag);
      context.giveCard(ana.userId, "bomber");
      return { ...context, ana, bruno, carla, clan };
    }

    it("asks for tokens of an owned card, once per cooldown", async () => {
      const { clans, ana, bruno, advance, giveCard, newPlayer } = await donors();
      const asked = await clans.requestDonation(ana.userId, "seeds.bomber");
      const own = asked.clan!.donations[0]!;
      assert.deepEqual([own.code, own.itemId, own.cardId, own.requested, own.received, own.mine, own.canDonate], [ana.code, "seeds.bomber", "bomber", 10, 0, true, false]);
      assert.ok(asked.donation.nextRequestAtUnix > 0);
      await assert.rejects(clans.requestDonation(ana.userId, "seeds.bomber", 3), (error: unknown) =>
        error instanceof AppError && error.errorCode === "CLAN_DONATION_LIMIT" && typeof (error.extra as { nextAtUnix: number }).nextAtUnix === "number");
      const seen = (await clans.info(bruno.userId)).clan!.donations[0]!;
      assert.deepEqual([seen.nickname, seen.mine, seen.canDonate], ["Ana", false, true]);

      await rejects(clans.requestDonation(bruno.userId, "seeds.bomber"), "CARD_NOT_OWNED");
      giveCard(bruno.userId, "bomber");
      await rejects(clans.requestDonation(bruno.userId, "seeds.wild"), "CLAN_DONATION_UNKNOWN");
      await rejects(clans.requestDonation(bruno.userId, "meteor_shard"), "CLAN_DONATION_UNKNOWN");
      await rejects(clans.requestDonation(bruno.userId, "nonexistent"), "CLAN_DONATION_UNKNOWN");
      await rejects(clans.requestDonation(bruno.userId, "seeds.bomber", 11), "INVALID_PAYLOAD");
      await clans.requestDonation(bruno.userId, "seeds.bomber", 2);

      advance(8 * HOUR_MS + 1000);
      assert.equal((await clans.info(ana.userId)).donation.nextRequestAtUnix, 0);
      assert.equal((await clans.info(ana.userId)).clan!.donations.length, 0, "expired requests leave the list");
      assert.equal((await clans.requestDonation(ana.userId, "seeds.bomber", 5)).clan!.donations[0]!.requested, 5);
      const outsider = await newPlayer("Outsider");
      giveCard(outsider.userId, "bomber");
      await rejects(clans.requestDonation(outsider.userId, "seeds.bomber"), "CLAN_NOT_MEMBER");
    });

    it("moves one token per donation through the ledgers and pays the donor", async () => {
      const { clans, ana, bruno, store, giveItems, tokens, coins } = await donors();
      await clans.requestDonation(ana.userId, "seeds.bomber", 3);
      giveItems(bruno.userId, "seeds.bomber", 4);
      const before = await coins(bruno.userId);
      const result = await clans.donate(bruno.userId, ana.code);
      assert.deepEqual([await tokens(bruno.userId), await tokens(ana.userId), await coins(bruno.userId)], [3, 1, before + 10]);
      assert.deepEqual([result.items["seeds.bomber"], result.wallet.coins, result.rewardCoins], [3, before + 10, 10]);
      const shown = result.clan!.donations[0]!;
      assert.deepEqual([shown.received, shown.myDonations, shown.canDonate], [1, 1, true]);
      assert.ok(store.itemLedger.some((e) => e.userId === bruno.userId && e.reason === "CLAN_DONATION" && e.delta === -1));
      assert.ok(store.itemLedger.some((e) => e.userId === ana.userId && e.reason === "CLAN_DONATION" && e.delta === 1));
      assert.ok(store.ledger.some((e) => e.userId === bruno.userId && e.reason === "CLAN_DONATION" && e.delta === 10));
      assert.equal((await clans.info(bruno.userId)).donation.donatedToday, 1);
    });

    it("refuses without tokens, to myself, to nobody and to a closed request", async () => {
      const { clans, ana, bruno, carla, giveItems, tokens, newPlayer } = await donors();
      await rejects(clans.donate(bruno.userId, ana.code), "CLAN_DONATION_UNKNOWN");
      await clans.requestDonation(ana.userId, "seeds.bomber", 2);
      await rejects(clans.donate(bruno.userId, ana.code), "ITEM_INSUFFICIENT");
      assert.equal(await tokens(ana.userId), 0, "a refused donation changes nothing");
      await rejects(clans.donate(ana.userId, ana.code), "CLAN_DONATION_UNKNOWN");
      await rejects(clans.donate(bruno.userId, "00000000"), "CLAN_DONATION_UNKNOWN");
      await rejects(clans.donate((await newPlayer("Outsider")).userId, ana.code), "CLAN_NOT_MEMBER");

      giveItems(bruno.userId, "seeds.bomber", 5);
      giveItems(carla.userId, "seeds.bomber", 5);
      await clans.donate(bruno.userId, ana.code);
      await clans.donate(carla.userId, ana.code);
      assert.equal(await tokens(ana.userId), 2);
      await rejects(clans.donate(bruno.userId, ana.code), "CLAN_DONATION_UNKNOWN");
      const full = (await clans.info(ana.userId)).clan!.donations[0]!;
      assert.deepEqual([full.received, full.requested], [2, 2]);
    });

    it("limits a donor per request and per day", async () => {
      const { clans, ana, bruno, carla, giveItems, tokens, advance, giveCard } = await donors({ donation: { maxPerDonorPerRequest: 2, maxPerDonorPerDay: 3 } });
      giveItems(bruno.userId, "seeds.bomber", 20);
      await clans.requestDonation(ana.userId, "seeds.bomber", 10);
      await clans.donate(bruno.userId, ana.code);
      await clans.donate(bruno.userId, ana.code);
      await assert.rejects(clans.donate(bruno.userId, ana.code), (error: unknown) => error instanceof AppError && error.errorCode === "CLAN_DONATION_LIMIT");
      assert.equal(await tokens(bruno.userId), 18);
      assert.equal((await clans.info(bruno.userId)).clan!.donations[0]!.canDonate, false);

      // a second request on the same day: the daily cap (3) allows one more
      giveCard(carla.userId, "bomber");
      await clans.requestDonation(carla.userId, "seeds.bomber", 10);
      await clans.donate(bruno.userId, carla.code);
      await assert.rejects(clans.donate(bruno.userId, carla.code), (error: unknown) =>
        error instanceof AppError && error.errorCode === "CLAN_DONATION_LIMIT" && (error.extra as { nextAtUnix: number }).nextAtUnix > 0);
      advance(24 * HOUR_MS);
      await clans.requestDonation(ana.userId, "seeds.bomber", 10);
      await clans.donate(bruno.userId, ana.code);
      assert.equal(await tokens(bruno.userId), 16);
    });

    it("stops donations to a member who left the clan", async () => {
      const { clans, ana, bruno, carla, giveItems } = await donors();
      giveItems(bruno.userId, "seeds.bomber", 5);
      await clans.requestDonation(ana.userId, "seeds.bomber");
      await clans.promote(ana.userId, carla.code);
      await clans.leave(ana.userId);
      await rejects(clans.donate(bruno.userId, ana.code), "CLAN_DONATION_UNKNOWN");
    });
  });
});
