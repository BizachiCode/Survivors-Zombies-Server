// Friends on in-memory repositories: friend codes, requests both ways (auto-accept), limits, remove, one gift per friend
// per UTC day, the daily collect cap, ledger rows and the public player card with its relations.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

import { AppError } from "../src/shared/errors/app-error.js";
import { publicUserId } from "../src/shared/kernel/public-id.js";
import { FRIENDS_CONFIG, type FriendsConfig } from "../src/modules/friends/friends-config.js";
import { FriendsService } from "../src/modules/friends/friends.service.js";
import { ProfileStatsReader } from "../src/modules/profile/profile-stats.js";
import { MemoryFriendsRepository } from "./support/memory-friends.js";
import { MemoryCollectionRepository } from "./support/memory-repositories.js";
import { createTestServices, testClock } from "./support/test-services.js";

const DAY_MS = 86_400_000;

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.errorCode === code);
}

function setup(config: Partial<FriendsConfig> = {}) {
  const services = createTestServices({ clock: testClock() });
  const repository = new MemoryFriendsRepository(services.store);
  const stats = new ProfileStatsReader(services.catalog, services.battleRepository, new MemoryCollectionRepository(services.store), services.objectivesRepository);
  const friends = new FriendsService(repository, services.profileRepository, services.rewards, services.wallets, services.inventory, stats,
    services.uow, services.clock, { ...FRIENDS_CONFIG, ...config });
  let counter = 0;
  const newPlayer = async (nickname?: string) => {
    counter++;
    const { userId } = await services.auth.deviceLogin({ deviceId: `device-friends-${String(counter).padStart(4, "0")}`, platform: "test" });
    if (nickname) services.store.profiles.get(userId)!.nickname = nickname;
    return { userId, code: publicUserId(userId) };
  };
  const befriend = async (a: { userId: string; code: string }, b: { userId: string; code: string }) => {
    await friends.request(a.userId, b.code);
    await friends.accept(b.userId, a.code);
  };
  return { ...services, repository, friends, newPlayer, befriend };
}

describe("friends", () => {
  it("shows my friend code and empty lists to a new player", async () => {
    const { friends, newPlayer } = setup();
    const ana = await newPlayer("Ana");
    const info = await friends.info(ana.userId);
    assert.equal(info.myCode, ana.code);
    assert.match(info.myCode, /^[0-9A-F]{8}$/);
    assert.deepEqual([info.friends, info.incoming, info.outgoing, info.giftsWaiting, info.giftsCollectableToday], [[], [], [], 0, 0]);
    assert.deepEqual(info.limits, { maxFriends: 50, maxIncoming: 50, maxOutgoing: 30, giftsPerDay: 10, gift: { currencies: { coins: 20 }, items: {}, exp: 0 } });
  });

  it("requests by code (any case, spaces ignored) and accepts", async () => {
    const { friends, newPlayer } = setup();
    const ana = await newPlayer("Ana");
    const bruno = await newPlayer("Bruno");

    const sent = await friends.request(ana.userId, ` ${ana.code === bruno.code ? "" : bruno.code.toLowerCase()} `);
    assert.deepEqual(sent.outgoing.map((r) => [r.code, r.nickname]), [[bruno.code, "Bruno"]]);
    assert.equal(sent.friends.length, 0);

    const seen = await friends.info(bruno.userId);
    assert.deepEqual(seen.incoming.map((r) => [r.code, r.nickname, r.level]), [[ana.code, "Ana", 1]]);
    assert.ok(seen.incoming[0]!.avatarId.length > 0 && seen.incoming[0]!.sentAtUnix > 0);

    const accepted = await friends.accept(bruno.userId, ana.code);
    assert.deepEqual([accepted.incoming.length, accepted.friends.map((f) => f.nickname)], [0, ["Ana"]]);
    assert.deepEqual((await friends.info(ana.userId)).friends.map((f) => f.code), [bruno.code]);
    assert.equal((await friends.info(ana.userId)).outgoing.length, 0);
  });

  it("turns a request into a friendship when the other player had already asked", async () => {
    const { friends, newPlayer } = setup();
    const ana = await newPlayer("Ana");
    const bruno = await newPlayer("Bruno");
    await friends.request(ana.userId, bruno.code);
    const info = await friends.request(bruno.userId, ana.code);
    assert.deepEqual(info.friends.map((f) => f.nickname), ["Ana"]);
    assert.deepEqual([info.incoming.length, info.outgoing.length], [0, 0]);
    assert.equal((await friends.info(ana.userId)).friends.length, 1);
  });

  it("two simultaneous requests end in exactly one friendship", async () => {
    const { friends, newPlayer, repository } = setup();
    const ana = await newPlayer();
    const bruno = await newPlayer();
    await Promise.all([friends.request(ana.userId, bruno.code), friends.request(bruno.userId, ana.code)]);
    assert.equal(repository.friendships.size, 1);
    assert.equal(repository.requests.size, 0);
  });

  it("refuses self, unknown codes, repeated requests and requests between friends", async () => {
    const { friends, newPlayer, befriend } = setup();
    const ana = await newPlayer();
    const bruno = await newPlayer();
    await rejects(friends.request(ana.userId, ana.code), "FRIEND_SELF");
    await rejects(friends.request(ana.userId, "ABCDEFGH"), "PLAYER_NOT_FOUND");
    await rejects(friends.request(ana.userId, "123"), "PLAYER_NOT_FOUND");
    await rejects(friends.request(ana.userId, "00000000"), "PLAYER_NOT_FOUND");

    await friends.request(ana.userId, bruno.code);
    await rejects(friends.request(ana.userId, bruno.code), "FRIEND_REQUEST_PENDING");
    await friends.accept(bruno.userId, ana.code);
    await rejects(friends.request(ana.userId, bruno.code), "FRIEND_ALREADY");
    await rejects(friends.request(bruno.userId, ana.code), "FRIEND_ALREADY");
  });

  it("answers PLAYER_NOT_FOUND when two accounts share the code", async () => {
    const { friends, newPlayer, store } = setup();
    const ana = await newPlayer();
    const bruno = await newPlayer();
    const twinId = `${ana.userId.slice(0, 8)}-dead-beef-0000-000000000000`;
    store.users.set(twinId, { ...store.users.get(ana.userId)!, id: twinId });
    store.profiles.set(twinId, { ...store.profiles.get(ana.userId)!, userId: twinId });
    await rejects(friends.request(bruno.userId, ana.code), "PLAYER_NOT_FOUND");
    await rejects(friends.player(bruno.userId, ana.code), "PLAYER_NOT_FOUND");
  });

  it("declines and cancels requests, and refuses answers to requests that do not exist", async () => {
    const { friends, newPlayer } = setup();
    const ana = await newPlayer();
    const bruno = await newPlayer();
    const carla = await newPlayer();

    await friends.request(ana.userId, bruno.code);
    await rejects(friends.accept(ana.userId, bruno.code), "FRIEND_REQUEST_UNKNOWN");
    await rejects(friends.decline(ana.userId, bruno.code), "FRIEND_REQUEST_UNKNOWN");
    await rejects(friends.cancel(bruno.userId, ana.code), "FRIEND_REQUEST_UNKNOWN");
    await rejects(friends.accept(bruno.userId, carla.code), "FRIEND_REQUEST_UNKNOWN");

    assert.equal((await friends.decline(bruno.userId, ana.code)).incoming.length, 0);
    assert.equal((await friends.info(ana.userId)).outgoing.length, 0);

    await friends.request(ana.userId, bruno.code);
    assert.equal((await friends.cancel(ana.userId, bruno.code)).outgoing.length, 0);
    assert.equal((await friends.info(bruno.userId)).incoming.length, 0);
    // after a decline the pair can ask again, either way
    assert.equal((await friends.request(bruno.userId, ana.code)).outgoing.length, 1);
  });

  it("enforces the friend, incoming and outgoing limits", async () => {
    const { friends, newPlayer, befriend } = setup({ maxFriends: 2, maxIncoming: 2, maxOutgoing: 2 });
    const me = await newPlayer("Me");
    const [p1, p2, p3, p4] = [await newPlayer(), await newPlayer(), await newPlayer(), await newPlayer()] as const;

    // outgoing: 2 allowed
    await friends.request(me.userId, p1.code);
    await friends.request(me.userId, p2.code);
    await assert.rejects(friends.request(me.userId, p3.code), (e: unknown) => e instanceof AppError && e.errorCode === "FRIEND_LIMIT" && e.extra?.max === 2);
    await friends.cancel(me.userId, p2.code);

    // incoming of the target: 2 allowed
    await friends.request(p2.userId, p4.code);
    await friends.request(p3.userId, p4.code);
    await rejects(friends.request(p1.userId, p4.code), "FRIEND_LIMIT");

    // friends: me + p1 and me + p2 fill my list (2); a third is refused on request and, for a request that was already waiting, on accept
    await friends.accept(p1.userId, me.code);
    await friends.request(p3.userId, me.code);
    await befriend(me, p2);
    assert.equal((await friends.info(me.userId)).friends.length, 2);
    await rejects(friends.accept(me.userId, p3.code), "FRIEND_LIMIT");
    await rejects(friends.request(me.userId, p4.code), "FRIEND_LIMIT");
    await rejects(friends.request(p4.userId, me.code), "FRIEND_LIMIT");
  });

  it("ignores requests older than the expiry and lets the pair ask again", async () => {
    const { friends, newPlayer, clock } = setup();
    const ana = await newPlayer();
    const bruno = await newPlayer();
    await friends.request(ana.userId, bruno.code);
    clock.set(clock.nowMs() + 31 * DAY_MS);
    assert.equal((await friends.info(bruno.userId)).incoming.length, 0);
    await rejects(friends.accept(bruno.userId, ana.code), "FRIEND_REQUEST_UNKNOWN");
    const info = await friends.request(bruno.userId, ana.code);
    assert.deepEqual([info.friends.length, info.outgoing.length], [0, 1], "a new request, not an accept of the expired one");
  });

  it("removes a friend for both sides", async () => {
    const { friends, newPlayer, befriend } = setup();
    const ana = await newPlayer();
    const bruno = await newPlayer();
    await rejects(friends.remove(ana.userId, bruno.code), "FRIEND_NOT_FRIENDS");
    await befriend(ana, bruno);
    assert.equal((await friends.remove(bruno.userId, ana.code)).friends.length, 0);
    assert.equal((await friends.info(ana.userId)).friends.length, 0);
    await rejects(friends.remove(ana.userId, bruno.code), "FRIEND_NOT_FRIENDS");
  });

  it("lists friends with level, last sign-in (when known) and gift flags", async () => {
    const { friends, newPlayer, befriend, repository, store } = setup();
    const ana = await newPlayer("Ana");
    const bruno = await newPlayer("bruno");
    const carla = await newPlayer("Carla");
    await befriend(ana, bruno);
    await befriend(ana, carla);
    store.profiles.get(carla.userId)!.level = 7;
    repository.lastLogin.set(carla.userId, new Date(Date.UTC(2026, 9, 20, 8, 0, 0)));

    const list = (await friends.info(ana.userId)).friends;
    assert.deepEqual(list.map((f) => f.nickname), ["bruno", "Carla"], "sorted by name, case-insensitive");
    const carlaRow = list[1]!;
    assert.equal(carlaRow.level, 7);
    assert.equal(carlaRow.lastSeenUnix, Date.UTC(2026, 9, 20, 8, 0, 0) / 1000);
    assert.equal("lastSeenUnix" in list[0]!, false, "no last sign-in recorded, so the field is absent");
    assert.deepEqual([carlaRow.giftSentToday, carlaRow.giftWaiting], [false, false]);
    assert.ok(carlaRow.since > 0);
  });

  describe("gifts", () => {
    it("sends one gift per friend per UTC day", async () => {
      const { friends, newPlayer, befriend, clock } = setup();
      const ana = await newPlayer();
      const bruno = await newPlayer();
      const carla = await newPlayer();
      await rejects(friends.sendGift(ana.userId, bruno.code), "FRIEND_NOT_FRIENDS");
      await befriend(ana, bruno);
      await rejects(friends.sendGift(ana.userId, ana.code), "FRIEND_SELF");

      const info = await friends.sendGift(ana.userId, bruno.code);
      assert.equal(info.friends[0]!.giftSentToday, true);
      assert.equal(info.friends[0]!.giftWaiting, false);
      await rejects(friends.sendGift(ana.userId, bruno.code), "FRIEND_GIFT_ALREADY_SENT");

      const received = await friends.info(bruno.userId);
      assert.deepEqual([received.giftsWaiting, received.giftsCollectableToday, received.friends[0]!.giftWaiting, received.friends[0]!.giftSentToday], [1, 1, true, false]);

      // bruno's own gift to ana is independent; carla is not a friend
      await friends.sendGift(bruno.userId, ana.code);
      await rejects(friends.sendGift(bruno.userId, carla.code), "FRIEND_NOT_FRIENDS");

      // next UTC day: allowed again
      clock.set(Date.UTC(2026, 9, 22, 0, 0, 1));
      assert.equal((await friends.info(ana.userId)).friends[0]!.giftSentToday, false);
      await friends.sendGift(ana.userId, bruno.code);
      assert.equal((await friends.info(bruno.userId)).giftsWaiting, 2);
    });

    it("the day rolls over at midnight UTC", async () => {
      const { friends, newPlayer, befriend, clock } = setup();
      const ana = await newPlayer();
      const bruno = await newPlayer();
      await befriend(ana, bruno);
      clock.set(Date.UTC(2026, 9, 21, 23, 59, 59));
      await friends.sendGift(ana.userId, bruno.code);
      await rejects(friends.sendGift(ana.userId, bruno.code), "FRIEND_GIFT_ALREADY_SENT");
      clock.set(Date.UTC(2026, 9, 22, 0, 0, 0));
      await friends.sendGift(ana.userId, bruno.code);
    });

    it("collects every waiting gift through the reward granter, once", async () => {
      const { friends, newPlayer, befriend, wallets, store } = setup();
      const ana = await newPlayer();
      const bruno = await newPlayer();
      const carla = await newPlayer();
      await befriend(ana, bruno);
      await befriend(carla, bruno);
      await friends.sendGift(ana.userId, bruno.code);
      await friends.sendGift(carla.userId, bruno.code);

      const before = (await wallets.snapshot(bruno.userId)).coins;
      const claim = await friends.claimGifts(bruno.userId);
      assert.deepEqual(claim.granted, { currencies: { coins: 40 }, items: {}, exp: 0 });
      assert.equal(claim.claimed, 2);
      assert.equal(claim.wallet.coins, before + 40);
      assert.deepEqual([claim.giftsWaiting, claim.giftsCollectableToday], [0, 0]);
      assert.equal(claim.friends.every((f) => !f.giftWaiting), true);
      assert.equal(claim.profile.level, 1);
      assert.deepEqual(claim.items, {});
      const rows = store.ledger.filter((entry) => entry.reason === "FRIEND_GIFT");
      assert.deepEqual(rows.map((r) => [r.userId, r.currencyId, r.delta]), [[bruno.userId, "coins", 40]]);

      await rejects(friends.claimGifts(bruno.userId), "FRIEND_NO_GIFTS");
      await rejects(friends.claimGifts(ana.userId), "FRIEND_NO_GIFTS");
    });

    it("collects at most the daily cap and keeps the rest waiting for tomorrow", async () => {
      const { friends, newPlayer, befriend, clock, wallets } = setup({ maxGiftsCollectedPerDay: 2 });
      const me = await newPlayer("Me");
      const others = [await newPlayer(), await newPlayer(), await newPlayer(), await newPlayer(), await newPlayer()];
      for (const other of others) {
        await befriend(me, other);
        await friends.sendGift(other.userId, me.code);
      }
      const info = await friends.info(me.userId);
      assert.deepEqual([info.giftsWaiting, info.giftsCollectableToday], [5, 2]);

      const before = (await wallets.snapshot(me.userId)).coins;
      const first = await friends.claimGifts(me.userId);
      assert.equal(first.claimed, 2);
      assert.deepEqual([first.giftsWaiting, first.giftsCollectableToday], [3, 0]);
      assert.equal(first.wallet.coins, before + 40);
      assert.equal(first.friends.filter((f) => f.giftWaiting).length, 3, "the oldest gifts were collected first");
      await rejects(friends.claimGifts(me.userId), "FRIEND_NO_GIFTS");

      clock.set(clock.nowMs() + DAY_MS);
      assert.equal((await friends.info(me.userId)).giftsCollectableToday, 2);
      assert.equal((await friends.claimGifts(me.userId)).claimed, 2);
      clock.set(clock.nowMs() + DAY_MS);
      const last = await friends.claimGifts(me.userId);
      assert.deepEqual([last.claimed, last.giftsWaiting], [1, 0]);
      assert.equal(last.wallet.coins, before + 100);
    });

    it("gifts still collectable after the friendship ended, and expired gifts are dropped", async () => {
      const { friends, newPlayer, befriend, clock } = setup();
      const ana = await newPlayer();
      const bruno = await newPlayer();
      await befriend(ana, bruno);
      await friends.sendGift(ana.userId, bruno.code);
      await friends.remove(ana.userId, bruno.code);
      assert.equal((await friends.info(bruno.userId)).giftsCollectableToday, 1);

      await befriend(ana, bruno);
      clock.set(clock.nowMs() + 31 * DAY_MS);
      assert.equal((await friends.info(bruno.userId)).giftsWaiting, 0);
      await rejects(friends.claimGifts(bruno.userId), "FRIEND_NO_GIFTS");
    });

    it("grants the configured bundle, so the gift can carry items or experience", async () => {
      const { friends, newPlayer, befriend } = setup({ gift: { currencies: { coins: 5 }, items: {}, exp: 30 } });
      const ana = await newPlayer();
      const bruno = await newPlayer();
      await befriend(ana, bruno);
      await friends.sendGift(ana.userId, bruno.code);
      const claim = await friends.claimGifts(bruno.userId);
      assert.deepEqual(claim.granted, { currencies: { coins: 5 }, items: {}, exp: 30 });
      assert.ok(claim.profile.exp === 30 || claim.profile.level > 1, "experience went through the granter");
    });
  });

  describe("player card", () => {
    it("shows the public card with the relation to me", async () => {
      const { friends, newPlayer, befriend, store } = setup();
      const ana = await newPlayer("Ana");
      const bruno = await newPlayer("Bruno");
      const carla = await newPlayer("Carla");
      const dani = await newPlayer("Dani");
      store.profiles.get(bruno.userId)!.level = 9;

      const self = await friends.player(ana.userId, ana.code);
      assert.deepEqual([self.code, self.nickname, self.relation], [ana.code, "Ana", "self"]);
      assert.deepEqual(self.stats, { battlesWon: 0, starsTotal: 0, crewOwned: 0, achievementsCompleted: 0 });

      assert.equal((await friends.player(ana.userId, bruno.code)).relation, "none");
      await befriend(ana, bruno);
      const card = await friends.player(ana.userId, bruno.code.toLowerCase());
      assert.deepEqual([card.relation, card.level, card.nickname], ["friend", 9, "Bruno"]);
      assert.ok(card.avatarId.length > 0);

      await friends.request(ana.userId, carla.code);
      assert.equal((await friends.player(ana.userId, carla.code)).relation, "outgoing");
      assert.equal((await friends.player(carla.userId, ana.code)).relation, "incoming");

      assert.equal((await friends.player(ana.userId, dani.code)).relation, "none");
      await rejects(friends.player(ana.userId, "FFFFFFFF"), "PLAYER_NOT_FOUND");
    });

    it("reports the battle, star, crew and achievement counts of the player", async () => {
      const { friends, newPlayer, battles, collection, objectives, catalog } = setup();
      const ana = await newPlayer("Ana");
      const bruno = await newPlayer("Bruno");
      await collection.info(bruno.userId);
      const stage = catalog.stages[0]!.id;
      await battles.finish(await battles.prepare(bruno.userId, stage), { kind: "VICTORY", seconds: 20, ticks: 400, baseHealth: 1, maxBaseHealth: 1, kills: 3, placed: 4, merges: 1 }, "hash");
      await objectives.claim(bruno.userId, "ach_win_1");
      const card = await friends.player(ana.userId, bruno.code);
      assert.equal(card.stats.battlesWon, 1);
      assert.ok(card.stats.starsTotal >= 1);
      assert.equal(card.stats.crewOwned, 3);
      assert.equal(card.stats.achievementsCompleted, 1);
    });
  });
});
