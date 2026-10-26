// Wire protocol of the `clan` room and of the clan chat channel (`chat` room, channel `clan:<id>`) through a real
// Colyseus server and SDK client (in-memory repositories): what the Unity client's OnlineBackendService (Clan partial) relies on.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { defineRoom, defineServer } from "@colyseus/core";
import { ColyseusTestServer } from "@colyseus/testing";

import { AuthRoom } from "../src/modules/auth/auth.room.js";
import { ChatProfileCache } from "../src/modules/chat/chat-profiles.js";
import { ChatRoom, configureChatChannelAccess } from "../src/modules/chat/chat.room.js";
import { ChatService } from "../src/modules/chat/chat.service.js";
import { createClanChatAccess, createClanChatPort } from "../src/modules/clans/clan-chat.js";
import { ClanRoom } from "../src/modules/clans/clans.room.js";
import { ClansService } from "../src/modules/clans/clans.service.js";
import { systemClock } from "../src/shared/kernel/clock.js";
import { configureRoomAuthentication } from "../src/shared/rooms/authenticated-room.js";
import { bindRoom } from "../src/shared/rooms/base-room.js";
import { unlimited } from "../src/shared/security/rate-limiter.js";
import { MemoryClansRepository } from "./support/memory-clans.js";
import { MemoryCollectionRepository } from "./support/memory-repositories.js";
import { createTestServices } from "./support/test-services.js";

const PORT = 2594;

function waitFor<T>(predicate: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("rooms: clan + clan chat protocol", () => {
  let colyseus: ColyseusTestServer;
  let services: ReturnType<typeof createTestServices>;

  before(async () => {
    services = createTestServices({ startingBalances: { coins: 5000 } });
    configureRoomAuthentication(services.authenticator);
    const repository = new MemoryClansRepository(services.store);
    const chat = new ChatService(systemClock);
    configureChatChannelAccess(createClanChatAccess(repository));
    const clans = new ClansService(repository, services.profileRepository, services.wallets, services.inventory, new MemoryCollectionRepository(services.store),
      services.catalog, createClanChatPort(chat), services.uow, systemClock);
    const server = defineServer({
      greet: false,
      rooms: {
        auth: defineRoom(bindRoom(AuthRoom, { auth: services.auth, limiter: unlimited, isMaintenanceEnabled: () => false })),
        clan: defineRoom(bindRoom(ClanRoom, { clans, queryLimiter: unlimited, changeLimiter: unlimited })),
        chat: defineRoom(bindRoom(ChatRoom, { chat, profiles: new ChatProfileCache(services.profileRepository, systemClock), historyLimiter: unlimited })).filterBy(["channel"]),
      },
    });
    await server.listen(PORT);
    colyseus = new ColyseusTestServer(server);
  });

  after(async () => {
    configureChatChannelAccess(null);
    await colyseus.shutdown();
  });

  async function signIn(deviceId: string, nickname: string): Promise<{ accessToken: string; userId: string; code: string }> {
    const auth = await colyseus.sdk.joinOrCreate("auth");
    const answer: any = await auth.request("auth", { type: "device", deviceId, platform: "test" });
    await auth.leave();
    assert.equal(answer.ok, true);
    services.store.profiles.get(answer.userId)!.nickname = nickname;
    return { accessToken: answer.accessToken, userId: answer.userId, code: answer.userId.slice(0, 8).toUpperCase() };
  }

  it("creates, searches, joins, promotes, kicks and leaves through the room", async () => {
    const ana = await signIn("device-clanroom-ana", "Ana");
    const bruno = await signIn("device-clanroom-bruno", "Bruno");
    const anaRoom = await colyseus.sdk.joinOrCreate("clan", { accessToken: ana.accessToken });
    const brunoRoom = await colyseus.sdk.joinOrCreate("clan", { accessToken: bruno.accessToken });

    const empty: any = await anaRoom.request("clan", { type: "info" });
    assert.deepEqual([empty.ok, empty.action, empty.clan, empty.pendingRequest, empty.recommended], [true, "info", null, null, []]);
    assert.equal(empty.limits.createCostCoins, 1000);
    assert.equal(empty.myCode, ana.code);

    const created: any = await anaRoom.request("clan", { type: "create", name: "Room Crew", description: "Hi", badge: "badge_05", clanType: "open", minLevel: 0 });
    assert.equal(created.ok, true);
    assert.equal(created.action, "create");
    assert.deepEqual([created.clan.name, created.clan.myRole, created.wallet.coins], ["Room Crew", "leader", 4000]);
    assert.match(created.clan.tag, /^[0-9A-Z]{6}$/);
    assert.ok(!JSON.stringify(created).includes(ana.userId), "full user ids never leave the server");

    const found: any = await brunoRoom.request("clan", { type: "search", query: "room" });
    assert.deepEqual(found.clans.map((c: any) => c.name), ["Room Crew"]);
    const joined: any = await brunoRoom.request("clan", { type: "join", tag: created.clan.tag });
    assert.deepEqual([joined.ok, joined.clan.members, joined.clan.myRole], [true, 2, "member"]);
    const promoted: any = await anaRoom.request("clan", { type: "promote", code: bruno.code });
    assert.equal(promoted.clan.roster.find((m: any) => m.code === bruno.code).role, "co_leader");
    const view: any = await brunoRoom.request("clan", { type: "view", tag: created.clan.tag });
    assert.deepEqual([view.ok, view.clan.name, view.clan.roster.length], [true, "Room Crew", 2]);
    const ranking: any = await brunoRoom.request("clan", { type: "ranking" });
    assert.deepEqual([ranking.ok, ranking.top.map((c: any) => c.name), ranking.me.name], [true, ["Room Crew"], "Room Crew"]);

    const left: any = await brunoRoom.request("clan", { type: "leave" });
    assert.deepEqual([left.ok, left.clan], [true, null]);

    assert.deepEqual(await anaRoom.request("clan", { type: "join", tag: created.clan.tag }), { action: "join", ok: false, error: "CLAN_ALREADY_MEMBER" });
    assert.deepEqual(await brunoRoom.request("clan", { type: "kick", code: ana.code }), { action: "kick", ok: false, error: "CLAN_NOT_MEMBER" });
    assert.deepEqual(await anaRoom.request("clan", { type: "create", name: "x", description: "", badge: "badge_01", clanType: "open", minLevel: 0 }), { action: "create", ok: false, error: "CLAN_NAME_INVALID" });
    assert.deepEqual(await anaRoom.request("clan", { type: "create", name: "Fine Name", description: "", badge: "badge_99", clanType: "open", minLevel: 0 }), { action: "create", ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await anaRoom.request("clan", { type: "create", name: "Fine Name", description: "", badge: "badge_01", type2: 1 }), { action: "create", ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await anaRoom.request("clan", { type: "dance" }), { action: "unknown", ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await anaRoom.request("clan", { type: "join", tag: "ZZZZZZ", amount: 3 }), { action: "join", ok: false, error: "INVALID_PAYLOAD" });
    await Promise.all([anaRoom.leave(), brunoRoom.leave()]);
    await assert.rejects(colyseus.sdk.joinOrCreate("clan", { accessToken: "forged" }));
  });

  it("opens the clan chat only for members, relays messages, system lines and drops kicked members", async () => {
    const ana = await signIn("device-clanchat-ana", "Ana");
    const bruno = await signIn("device-clanchat-bruno", "Bruno");
    const carla = await signIn("device-clanchat-carla", "Carla");
    const anaClan = await colyseus.sdk.joinOrCreate("clan", { accessToken: ana.accessToken });
    const brunoClan = await colyseus.sdk.joinOrCreate("clan", { accessToken: bruno.accessToken });
    const created: any = await anaClan.request("clan", { type: "create", name: "Chat Crew", description: "", badge: "badge_01", clanType: "open", minLevel: 0 });
    const channel = created.clan.channel as string;
    assert.match(channel, /^clan:/);

    // Not a member yet: matchmaking refuses the channel. The global channel is unchanged.
    await assert.rejects(colyseus.sdk.joinOrCreate("chat", { accessToken: bruno.accessToken, channel }), (e: any) => e.code === 403 && /CLAN_NOT_MEMBER/.test(e.message));
    await assert.rejects(colyseus.sdk.joinOrCreate("chat", { accessToken: bruno.accessToken, channel: "clan:not-a-real-clan" }));
    const globalRoom = await colyseus.sdk.joinOrCreate("chat", { accessToken: carla.accessToken, channel: "global" });
    const globalHistory: any = await globalRoom.request("chat", { type: "history" });
    assert.match(globalHistory.messages[0].text, /global chat/);
    await globalRoom.leave();

    await brunoClan.request("clan", { type: "join", tag: created.clan.tag });
    const anaChat = await colyseus.sdk.joinOrCreate("chat", { accessToken: ana.accessToken, channel });
    const brunoChat = await colyseus.sdk.joinOrCreate("chat", { accessToken: bruno.accessToken, channel });
    const received: Record<string, any[]> = { ana: [], bruno: [] };
    anaChat.onMessage("message", (m: any) => received.ana.push(m));
    brunoChat.onMessage("message", (m: any) => received.bruno.push(m));
    let brunoLeft = false;
    brunoChat.onMessage("evicted", () => undefined);
    brunoChat.onLeave(() => { brunoLeft = true; });

    const history: any = await anaChat.request("chat", { type: "history" });
    assert.match(history.messages[0].text, /clan chat/);
    assert.ok(history.messages.some((m: any) => m.system && /Bruno joined the clan/.test(m.text)), "joins are system lines in the history");
    await brunoChat.request("chat", { type: "history" });

    const said: any = await anaChat.request("chat", { type: "say", text: "ahoy clan" });
    assert.equal(said.ok, true);
    await waitFor(() => received.ana.length === 1 && received.bruno.length === 1);
    assert.deepEqual([received.bruno[0].text, received.bruno[0].nickname, received.bruno[0].system], ["ahoy clan", "Ana", false]);

    // Kicking Bruno closes the clan chat for him and posts a system line for the rest.
    await anaClan.request("clan", { type: "kick", code: bruno.code });
    await waitFor(() => brunoLeft);
    await waitFor(() => received.ana.some((m) => m.system && /Bruno was removed/.test(m.text)));
    assert.equal(received.bruno.some((m) => /removed/.test(m.text)), false, "the kicked member does not get the line");
    await pause(50);
    await assert.rejects(colyseus.sdk.joinOrCreate("chat", { accessToken: bruno.accessToken, channel }), (e: any) => e.code === 403);

    await Promise.all([anaChat.leave(), anaClan.leave(), brunoClan.leave()]);
  });
});
