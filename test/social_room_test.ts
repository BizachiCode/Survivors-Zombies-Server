// Wire protocol of the `ranking` and `chat` rooms through a real Colyseus server and SDK client (in-memory repositories):
// what the Unity client's OnlineBackendService (Ranking / Chat partials) relies on.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { defineRoom, defineServer } from "@colyseus/core";
import { ColyseusTestServer } from "@colyseus/testing";

import { AuthRoom } from "../src/modules/auth/auth.room.js";
import { ChatProfileCache } from "../src/modules/chat/chat-profiles.js";
import { ChatRoom } from "../src/modules/chat/chat.room.js";
import { ChatService } from "../src/modules/chat/chat.service.js";
import { RankingRoom } from "../src/modules/ranking/ranking.room.js";
import { RankingService } from "../src/modules/ranking/ranking.service.js";
import { systemClock } from "../src/shared/kernel/clock.js";
import { configureRoomAuthentication } from "../src/shared/rooms/authenticated-room.js";
import { bindRoom } from "../src/shared/rooms/base-room.js";
import { unlimited } from "../src/shared/security/rate-limiter.js";
import { MemoryRankingRepository } from "./support/memory-ranking.js";
import { createTestServices } from "./support/test-services.js";

const PORT = 2593;

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

describe("rooms: ranking + chat protocol", () => {
  let colyseus: ColyseusTestServer;
  let services: ReturnType<typeof createTestServices>;

  before(async () => {
    services = createTestServices();
    configureRoomAuthentication(services.authenticator);
    const rankings = new RankingService(new MemoryRankingRepository(services.store), systemClock);
    const chat = new ChatService(systemClock);
    const profiles = new ChatProfileCache(services.profileRepository, systemClock);
    const server = defineServer({
      greet: false,
      rooms: {
        auth: defineRoom(bindRoom(AuthRoom, { auth: services.auth, limiter: unlimited, isMaintenanceEnabled: () => false })),
        ranking: defineRoom(bindRoom(RankingRoom, { rankings, queryLimiter: unlimited })),
        chat: defineRoom(bindRoom(ChatRoom, { chat, profiles, historyLimiter: unlimited })).filterBy(["channel"]),
      },
    });
    // `boot()` of a defineServer() server ignores the port (always 2568); listening here keeps the test off a running dev server.
    await server.listen(PORT);
    colyseus = new ColyseusTestServer(server);
  });

  after(async () => colyseus.shutdown());

  async function signIn(deviceId: string, nickname?: string): Promise<{ accessToken: string; userId: string }> {
    const auth = await colyseus.sdk.joinOrCreate("auth");
    const answer: any = await auth.request("auth", { type: "device", deviceId, platform: "test" });
    await auth.leave();
    assert.equal(answer.ok, true);
    if (nickname) services.store.profiles.get(answer.userId)!.nickname = nickname;
    return { accessToken: answer.accessToken, userId: answer.userId };
  }

  it("serves the leaderboards: top, own row, errors", async () => {
    const ana = await signIn("device-social-ana", "Ana");
    const bruno = await signIn("device-social-bruno", "Bruno");
    services.store.stageProgress.set(`${ana.userId}:s0`, { userId: ana.userId, stageId: "s0", bestStars: 3, wins: 1, plays: 1, bestTimeMs: 1, firstClearedAt: null });
    services.store.stageProgress.set(`${bruno.userId}:s0`, { userId: bruno.userId, stageId: "s0", bestStars: 2, wins: 1, plays: 1, bestTimeMs: 1, firstClearedAt: null });

    const room = await colyseus.sdk.joinOrCreate("ranking", { accessToken: bruno.accessToken });
    const info: any = await room.request("ranking", { type: "info", board: "stars" });
    assert.equal(info.ok, true);
    assert.equal(info.action, "info");
    assert.equal(info.board, "stars");
    assert.deepEqual(info.top.map((e: any) => [e.rank, e.nickname, e.score]), [[1, "Ana", 3], [2, "Bruno", 2]]);
    assert.deepEqual([info.me.rank, info.me.nickname, info.me.userId], [2, "Bruno", bruno.userId.slice(0, 8).toUpperCase()]);
    assert.ok(info.refreshedAtUnix > 0);
    assert.ok(!JSON.stringify(info).includes(ana.userId), "full user ids never leave the server");

    const wins: any = await room.request("ranking", { type: "info", board: "wins" });
    assert.deepEqual([wins.ok, wins.top, wins.me], [true, [], null]);

    assert.deepEqual(await room.request("ranking", { type: "info", board: "gold" }), { action: "info", ok: false, error: "RANKING_UNKNOWN_BOARD" });
    assert.deepEqual(await room.request("ranking", { type: "info" }), { action: "info", ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await room.request("ranking", { type: "info", board: "stars", userId: "x" }), { action: "info", ok: false, error: "INVALID_PAYLOAD" });
    await room.leave();
    await assert.rejects(colyseus.sdk.joinOrCreate("ranking", { accessToken: "forged" }));
  });

  it("relays chat messages to everybody who asked for the history, and only to them", async () => {
    const ana = await signIn("device-chat-ana", "Ana");
    const bruno = await signIn("device-chat-bruno", "Bruno");
    const carla = await signIn("device-chat-carla", "Carla");
    services.store.profiles.get(ana.userId)!.level = 4;

    const join = (accessToken: string) => colyseus.sdk.joinOrCreate("chat", { accessToken, channel: "global" });
    const [anaRoom, brunoRoom, carlaRoom] = await Promise.all([join(ana.accessToken), join(bruno.accessToken), join(carla.accessToken)]);
    const received: Record<string, any[]> = { ana: [], bruno: [], carla: [] };
    anaRoom.onMessage("message", (m: any) => received.ana.push(m));
    brunoRoom.onMessage("message", (m: any) => received.bruno.push(m));
    carlaRoom.onMessage("message", (m: any) => received.carla.push(m));

    const before: any = await anaRoom.request("chat", { type: "history" });
    assert.equal(before.ok, true);
    assert.equal(before.action, "history");
    assert.equal(before.messages.length, 1);
    assert.deepEqual([before.messages[0].system, before.messages[0].userId], [true, ""]);
    assert.ok(before.messages[0].text.length > 0);
    await brunoRoom.request("chat", { type: "history" });

    const said: any = await anaRoom.request("chat", { type: "say", text: "  Hello   crew  " });
    assert.equal(said.ok, true);
    assert.equal(said.action, "say");
    assert.deepEqual(
      { ...said.message, id: undefined, atUnix: undefined },
      { id: undefined, atUnix: undefined, userId: ana.userId.slice(0, 8).toUpperCase(), nickname: "Ana", avatarId: said.message.avatarId, level: 4, text: "Hello crew", system: false },
    );
    assert.ok(said.message.atUnix > 0);

    await waitFor(() => received.ana.length === 1 && received.bruno.length === 1);
    assert.deepEqual(received.bruno[0], said.message);
    assert.deepEqual(received.ana[0], said.message);

    // Carla never asked for the history: nothing is pushed to her until she does.
    await pause(100);
    assert.equal(received.carla.length, 0);
    const late: any = await carlaRoom.request("chat", { type: "history" });
    assert.deepEqual(late.messages.map((m: any) => m.text).slice(1), ["Hello crew"]);

    await brunoRoom.request("chat", { type: "say", text: "what the SHIT" });
    await waitFor(() => received.carla.length === 1 && received.ana.length === 2);
    assert.equal(received.carla[0].text, "what the ****");
    assert.equal(received.carla[0].nickname, "Bruno");

    await Promise.all([anaRoom.leave(), brunoRoom.leave(), carlaRoom.leave()]);
  });

  it("refuses bad messages, spam and unknown channels", async () => {
    const dino = await signIn("device-chat-dino", "Dino");
    const room = await colyseus.sdk.joinOrCreate("chat", { accessToken: dino.accessToken, channel: "global" });
    room.onMessage("message", () => {});
    await room.request("chat", { type: "history" });

    assert.deepEqual(await room.request("chat", { type: "say", text: "   " }), { action: "say", ok: false, error: "CHAT_INVALID_MESSAGE" });
    assert.deepEqual(await room.request("chat", { type: "say", text: "x".repeat(141) }), { action: "say", ok: false, error: "CHAT_INVALID_MESSAGE" });
    assert.deepEqual(await room.request("chat", { type: "say" }), { action: "say", ok: false, error: "INVALID_PAYLOAD" });
    assert.deepEqual(await room.request("chat", { type: "shout", text: "hi" }), { action: "unknown", ok: false, error: "INVALID_PAYLOAD" });

    for (const text of ["one", "two", "three"]) assert.equal(((await room.request("chat", { type: "say", text })) as any).ok, true);
    assert.deepEqual(await room.request("chat", { type: "say", text: "four" }), { action: "say", ok: false, error: "RATE_LIMIT" });
    await pause(1600);
    assert.equal(((await room.request("chat", { type: "say", text: "four" })) as any).ok, true);

    // The same text three times in a row mutes the account.
    for (const text of ["spam", "spam"]) {
      await pause(1600);
      assert.equal(((await room.request("chat", { type: "say", text })) as any).ok, true);
    }
    await pause(1600);
    const muted: any = await room.request("chat", { type: "say", text: "spam" });
    assert.deepEqual([muted.ok, muted.error], [false, "CHAT_MUTED"]);
    assert.ok(muted.extra.untilUnix > Math.floor(Date.now() / 1000) + 50);
    await room.leave();

    await assert.rejects(colyseus.sdk.joinOrCreate("chat", { accessToken: dino.accessToken, channel: "vip" }), (e: any) => e.code === 400 && /INVALID_PAYLOAD/.test(e.message));
    await assert.rejects(colyseus.sdk.joinOrCreate("chat", { accessToken: "forged", channel: "global" }));
  });
});
