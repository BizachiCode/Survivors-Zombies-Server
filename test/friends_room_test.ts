// Wire protocol of the `friends` room through a real Colyseus server and SDK client (in-memory repositories):
// what the Unity client's OnlineBackendService (Friends partial) relies on.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { defineRoom, defineServer } from "@colyseus/core";
import { ColyseusTestServer } from "@colyseus/testing";

import { AuthRoom } from "../src/modules/auth/auth.room.js";
import { FriendsRoom } from "../src/modules/friends/friends.room.js";
import { FriendsService } from "../src/modules/friends/friends.service.js";
import { ProfileStatsReader } from "../src/modules/profile/profile-stats.js";
import { systemClock } from "../src/shared/kernel/clock.js";
import { configureRoomAuthentication } from "../src/shared/rooms/authenticated-room.js";
import { bindRoom } from "../src/shared/rooms/base-room.js";
import { unlimited } from "../src/shared/security/rate-limiter.js";
import { MemoryFriendsRepository } from "./support/memory-friends.js";
import { MemoryCollectionRepository } from "./support/memory-repositories.js";
import { createTestServices } from "./support/test-services.js";

const PORT = 2599;

describe("rooms: friends protocol", () => {
  let colyseus: ColyseusTestServer;
  let services: ReturnType<typeof createTestServices>;

  before(async () => {
    services = createTestServices();
    configureRoomAuthentication(services.authenticator);
    const stats = new ProfileStatsReader(services.catalog, services.battleRepository, new MemoryCollectionRepository(services.store), services.objectivesRepository);
    const friends = new FriendsService(new MemoryFriendsRepository(services.store), services.profileRepository, services.rewards, services.wallets,
      services.inventory, stats, services.uow, systemClock);
    const server = defineServer({
      greet: false,
      rooms: {
        auth: defineRoom(bindRoom(AuthRoom, { auth: services.auth, limiter: unlimited, isMaintenanceEnabled: () => false })),
        friends: defineRoom(bindRoom(FriendsRoom, { friends, queryLimiter: unlimited, changeLimiter: unlimited })),
      },
    });
    // `boot()` of a defineServer() server ignores the port (always 2568); listening here keeps the test off a running dev server.
    await server.listen(PORT);
    colyseus = new ColyseusTestServer(server);
  });

  after(async () => colyseus.shutdown());

  async function signIn(deviceId: string, nickname: string): Promise<{ accessToken: string; userId: string; code: string }> {
    const auth = await colyseus.sdk.joinOrCreate("auth");
    const answer: any = await auth.request("auth", { type: "device", deviceId, platform: "test" });
    await auth.leave();
    assert.equal(answer.ok, true);
    services.store.profiles.get(answer.userId)!.nickname = nickname;
    return { accessToken: answer.accessToken, userId: answer.userId, code: answer.userId.slice(0, 8).toUpperCase() };
  }

  it("runs the whole friend flow: request, accept, gift, collect, card, remove", async () => {
    const ana = await signIn("device-friends-ana", "Ana");
    const bruno = await signIn("device-friends-bruno", "Bruno");
    const anaRoom = await colyseus.sdk.joinOrCreate("friends", { accessToken: ana.accessToken });
    const brunoRoom = await colyseus.sdk.joinOrCreate("friends", { accessToken: bruno.accessToken });

    const info: any = await anaRoom.request("friends", { type: "info" });
    assert.deepEqual([info.ok, info.action, info.myCode], [true, "info", ana.code]);
    assert.deepEqual([info.friends, info.incoming, info.outgoing, info.giftsWaiting, info.giftsCollectableToday], [[], [], [], 0, 0]);
    assert.deepEqual(info.limits.gift, { currencies: { coins: 20 }, items: {}, exp: 0 });

    const requested: any = await anaRoom.request("friends", { type: "request", code: bruno.code.toLowerCase() });
    assert.deepEqual([requested.ok, requested.action, requested.outgoing.map((r: any) => r.nickname)], [true, "request", ["Bruno"]]);
    const seen: any = await brunoRoom.request("friends", { type: "info" });
    assert.deepEqual(seen.incoming.map((r: any) => [r.code, r.nickname]), [[ana.code, "Ana"]]);

    const accepted: any = await brunoRoom.request("friends", { type: "accept", code: ana.code });
    assert.deepEqual([accepted.action, accepted.friends.map((f: any) => f.nickname), accepted.incoming], ["accept", ["Ana"], []]);

    const sent: any = await anaRoom.request("friends", { type: "send_gift", code: bruno.code });
    assert.equal(sent.friends[0].giftSentToday, true);
    assert.deepEqual(await anaRoom.request("friends", { type: "send_gift", code: bruno.code }), { action: "send_gift", ok: false, error: "FRIEND_GIFT_ALREADY_SENT" });

    const before = (await services.wallets.snapshot(bruno.userId)).coins;
    const claimed: any = await brunoRoom.request("friends", { type: "claim_gifts" });
    assert.deepEqual([claimed.ok, claimed.action, claimed.claimed, claimed.giftsWaiting], [true, "claim_gifts", 1, 0]);
    assert.deepEqual(claimed.granted, { currencies: { coins: 20 }, items: {}, exp: 0 });
    assert.equal(claimed.wallet.coins, before + 20);
    assert.ok(claimed.profile.nickname === "Bruno" && claimed.items);
    assert.deepEqual(await brunoRoom.request("friends", { type: "claim_gifts" }), { action: "claim_gifts", ok: false, error: "FRIEND_NO_GIFTS" });

    const card: any = await brunoRoom.request("friends", { type: "player", code: ana.code });
    assert.deepEqual([card.ok, card.action, card.code, card.nickname, card.relation], [true, "player", ana.code, "Ana", "friend"]);
    assert.deepEqual(Object.keys(card.stats).sort(), ["achievementsCompleted", "battlesWon", "crewOwned", "starsTotal"]);
    assert.ok(!JSON.stringify(card).includes(ana.userId), "full user ids never leave the server");
    assert.equal(((await brunoRoom.request("friends", { type: "player", code: bruno.code })) as any).relation, "self");

    const removed: any = await brunoRoom.request("friends", { type: "remove", code: ana.code });
    assert.deepEqual([removed.ok, removed.friends], [true, []]);
    assert.equal(((await anaRoom.request("friends", { type: "info" })) as any).friends.length, 0);
    await anaRoom.leave();
    await brunoRoom.leave();
  });

  it("answers errors with the action and a stable code, and rejects bad payloads", async () => {
    const carla = await signIn("device-friends-carla", "Carla");
    const room = await colyseus.sdk.joinOrCreate("friends", { accessToken: carla.accessToken });
    assert.deepEqual(await room.request("friends", { type: "request", code: carla.code }), { action: "request", ok: false, error: "FRIEND_SELF" });
    assert.deepEqual(await room.request("friends", { type: "request", code: "00000000" }), { action: "request", ok: false, error: "PLAYER_NOT_FOUND" });
    assert.deepEqual(await room.request("friends", { type: "accept", code: "ZZZZ" }), { action: "accept", ok: false, error: "PLAYER_NOT_FOUND" });
    assert.deepEqual(await room.request("friends", { type: "player", code: "FFFFFFFF" }), { action: "player", ok: false, error: "PLAYER_NOT_FOUND" });
    assert.deepEqual(await room.request("friends", { type: "request" }), { action: "request", ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await room.request("friends", { type: "info", userId: "x" }), { action: "info", ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await room.request("friends", { type: "teleport" }), { action: "unknown", ok: false, error: "INVALID_PAYLOAD" });
    await room.leave();
    await assert.rejects(colyseus.sdk.joinOrCreate("friends", { accessToken: "forged" }));
  });
});
