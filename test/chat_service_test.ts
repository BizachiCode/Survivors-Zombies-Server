// Chat rules without a transport: normalization, the word filter, rate limit, repeat mute, history and listeners.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

import { AppError } from "../src/shared/errors/app-error.js";
import { fixedClock } from "../src/shared/kernel/clock.js";
import { DEFAULT_CHAT_CONFIG } from "../src/modules/chat/chat-config.js";
import { ChatProfileCache } from "../src/modules/chat/chat-profiles.js";
import type { ChatHistoryStore } from "../src/modules/chat/chat-history.js";
import { ChatService, type ChatMessageDto, type ChatSender } from "../src/modules/chat/chat.service.js";
import { createTestServices } from "./support/test-services.js";

const ANA: ChatSender = { userId: "0a1b2c3d-1111-2222-3333-444455556666", nickname: "Ana", avatarId: "pirate_1", level: 4 };
const BRUNO: ChatSender = { userId: "ffeeddcc-1111-2222-3333-444455556666", nickname: "Bruno", avatarId: "pirate_2", level: 9 };

function rejects(work: () => unknown, code: string, extra?: Record<string, unknown>): void {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof AppError, `AppError expected, got ${String(error)}`);
    assert.equal(error.errorCode, code);
    if (extra) assert.deepEqual(error.extra, extra);
    return;
  }
  assert.fail(`expected ${code}`);
}

describe("chat service", () => {
  let clock: ReturnType<typeof fixedClock>;
  let chat: ChatService;

  beforeEach(() => {
    clock = fixedClock(Date.UTC(2026, 9, 21, 12, 0, 0));
    chat = new ChatService(clock);
  });

  it("normalizes: trims, collapses whitespace, strips control characters, refuses empty and too long text", () => {
    assert.equal(chat.normalize("  hello \t  \n world  "), "hello world");
    assert.equal(chat.normalize("a\u0000b​c‮d"), "abcd");
    assert.equal(chat.normalize("x".repeat(140)).length, 140);
    for (const bad of ["", "   ", "\n\t", "​\u0007", "x".repeat(141)]) rejects(() => chat.normalize(bad), "CHAT_INVALID_MESSAGE");
    assert.equal(chat.normalize("😀".repeat(140)).length, 280, "the limit counts characters, not UTF-16 units");
  });

  it("masks filtered words (whole words, any case) keeping the length", () => {
    assert.equal(chat.filter("what the SHIT is this"), "what the **** is this");
    assert.equal(chat.filter("Porra, caralho!"), "*****, *******!");
    assert.equal(chat.filter("classic assassin shiitake"), "classic assassin shiitake", "no false positives inside other words");
    assert.equal(chat.filter("all good here"), "all good here");
    assert.equal(chat.post("global", ANA, "  Merda   total ").text, "***** total");
  });

  it("builds the message with the public id, profile data and a growing id", () => {
    const first = chat.post("global", ANA, "hi");
    const second = chat.post("global", BRUNO, "hello");
    assert.deepEqual(first, { id: "1", userId: "0A1B2C3D", nickname: "Ana", avatarId: "pirate_1", level: 4, text: "hi", atUnix: clock.nowUnix(), system: false });
    assert.equal(second.id, "2");
    assert.equal(second.userId, "FFEEDDCC");
  });

  it("allows a burst of 3 then one message every 1.5 seconds, per user", () => {
    for (const text of ["a", "b", "c"]) chat.post("global", ANA, text);
    rejects(() => chat.post("global", ANA, "d"), "RATE_LIMIT");
    assert.equal(chat.post("global", BRUNO, "mine").text, "mine", "other users are not affected");
    clock.set(clock.nowMs() + 1400);
    rejects(() => chat.post("global", ANA, "d"), "RATE_LIMIT");
    clock.set(clock.nowMs() + 200);
    assert.equal(chat.post("global", ANA, "d").text, "d");
    rejects(() => chat.post("global", ANA, "e"), "RATE_LIMIT");
  });

  it("mutes for 60 seconds after the same message three times in a row", () => {
    const say = (text: string) => { clock.set(clock.nowMs() + 2000); return chat.post("global", ANA, text); };
    say("buy gems");
    say("Buy  GEMS");
    const until = Math.ceil((clock.nowMs() + 2000 + 60_000) / 1000);
    rejects(() => say("buy gems"), "CHAT_MUTED", { untilUnix: until });
    clock.set(clock.nowMs() + 30_000);
    rejects(() => chat.post("global", ANA, "something else"), "CHAT_MUTED", { untilUnix: until });
    assert.equal(chat.post("global", BRUNO, "unaffected").text, "unaffected");
    clock.set(until * 1000);
    assert.equal(chat.post("global", ANA, "back").text, "back");
    assert.equal(chat.history("global").filter((m) => m.text.toLowerCase() === "buy gems").length, 2, "the refused message was not published");
  });

  it("does not count different messages in between as repeats", () => {
    const say = (text: string) => { clock.set(clock.nowMs() + 2000); return chat.post("global", ANA, text); };
    for (const text of ["gg", "gg", "ok", "gg", "gg", "ok"]) say(text);
    assert.equal(chat.history("global").length, 7);
  });

  it("keeps the welcome line plus the last 50 messages, per channel", () => {
    for (let i = 1; i <= 60; i++) {
      clock.set(clock.nowMs() + 2000);
      chat.post("global", i % 2 ? ANA : BRUNO, `message ${i}`);
    }
    const history = chat.history("global");
    assert.equal(history.length, 1 + DEFAULT_CHAT_CONFIG.historySize);
    assert.deepEqual([history[0].system, history[0].id, history[0].userId], [true, "0", ""]);
    assert.deepEqual([history[1].text, history[50].text], ["message 11", "message 60"]);
    assert.equal(chat.history("other").length, 1, "channels have their own history");
  });

  it("delivers published messages to the listeners of the channel until they unsubscribe", () => {
    const seen: string[] = [];
    const stop = chat.subscribe("global", (message) => seen.push(message.text));
    chat.subscribe("other", () => assert.fail("another channel"));
    chat.post("global", ANA, "one");
    stop();
    chat.post("global", BRUNO, "two");
    assert.deepEqual(seen, ["one"]);
  });
});

/** A persistent store kept in a map that outlives the services built in a test (a "restart" builds a new service). */
class FakeHistoryStore implements ChatHistoryStore {
  readonly persistent = true;
  readonly channels = new Map<string, ChatMessageDto[]>();
  failLoad = false;
  /** Pending loads wait for this when set (to publish while a channel is still loading). */
  gate: Promise<void> | null = null;

  async load(channelId: string, limit: number): Promise<ChatMessageDto[]> {
    if (this.gate) await this.gate;
    if (this.failLoad) throw new Error("store down");
    return (this.channels.get(channelId) ?? []).slice(-limit);
  }

  async append(channelId: string, message: ChatMessageDto, limit: number): Promise<void> {
    const list = [...(this.channels.get(channelId) ?? []), message];
    this.channels.set(channelId, list.slice(-limit));
  }

  async clear(channelId: string): Promise<void> {
    this.channels.delete(channelId);
  }
}

describe("chat history store", () => {
  let clock: ReturnType<typeof fixedClock>;
  let store: FakeHistoryStore;
  const restart = () => new ChatService(clock, DEFAULT_CHAT_CONFIG, store);
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    clock = fixedClock(Date.UTC(2026, 9, 21, 12, 0, 0));
    store = new FakeHistoryStore();
  });

  it("keeps the history across a restart and continues the message ids", async () => {
    const first = restart();
    await first.ready("global");
    first.post("global", ANA, "before the restart");
    clock.set(clock.nowMs() + 2000);
    first.post("global", BRUNO, "me too");
    await settle();

    const second = restart();
    await second.ready("global");
    assert.deepEqual(second.history("global").slice(1).map((m) => [m.id, m.text]), [["1", "before the restart"], ["2", "me too"]]);
    clock.set(clock.nowMs() + 2000);
    assert.equal(second.post("global", ANA, "after").id, "3", "new ids follow the stored ones");
  });

  it("stores only the last messages of each channel", async () => {
    const chat = restart();
    await chat.ready("global");
    for (let i = 1; i <= 60; i++) {
      clock.set(clock.nowMs() + 2000);
      chat.post("global", i % 2 ? ANA : BRUNO, `message ${i}`);
    }
    await settle();
    const stored = store.channels.get("global")!;
    assert.equal(stored.length, DEFAULT_CHAT_CONFIG.historySize);
    assert.deepEqual([stored[0].text, stored[stored.length - 1].text], ["message 11", "message 60"]);
  });

  it("publishes a system line sent while the channel loads after the stored messages", async () => {
    store.channels.set("clan:c1", [{ id: "7", userId: "0a1b2c3d", nickname: "Ana", avatarId: "pirate_1", level: 4, text: "hi", atUnix: 1, system: false }]);
    let open!: () => void;
    store.gate = new Promise((resolve) => { open = resolve; });
    const chat = restart();
    assert.equal(chat.postSystem("clan:c1", "Bruno joined the clan.", "text_clan_joined", ["Bruno"]), null, "queued until loaded");
    assert.throws(() => chat.history("clan:c1"), /await ready/);
    open();
    await chat.ready("clan:c1");
    await settle();
    const lines = chat.history("clan:c1").slice(1);
    assert.deepEqual(lines.map((m) => [m.id, m.text]), [["7", "hi"], ["8", "Bruno joined the clan."]]);
    assert.deepEqual([lines[1].key, lines[1].args], ["text_clan_joined", ["Bruno"]]);
    assert.equal(store.channels.get("clan:c1")!.length, 2, "the system line is stored too");
  });

  it("forgets the stored copy of a closed channel", async () => {
    const chat = restart();
    await chat.ready("clan:c2");
    chat.post("clan:c2", ANA, "bye");
    await settle();
    chat.closeChannel("clan:c2");
    await settle();
    assert.equal(store.channels.has("clan:c2"), false);
  });

  it("starts with an empty history when the store can not be read", async () => {
    store.failLoad = true;
    const chat = restart();
    await chat.ready("global");
    assert.equal(chat.history("global").length, 1, "only the welcome line");
    assert.equal(chat.post("global", ANA, "still works").id, "1");
  });
});

describe("chat profile cache", () => {
  it("reads the profile once per 30 seconds", async () => {
    const services = createTestServices();
    const { userId } = await services.auth.deviceLogin({ deviceId: "device-chat-profile", platform: "test" });
    const clock = fixedClock(Date.UTC(2026, 9, 21, 12, 0, 0));
    const cache = new ChatProfileCache(services.profileRepository, clock);

    services.store.profiles.get(userId)!.nickname = "Old";
    assert.equal((await cache.senderOf(userId)).nickname, "Old");
    services.store.profiles.get(userId)!.nickname = "New";
    clock.set(clock.nowMs() + 29_000);
    assert.equal((await cache.senderOf(userId)).nickname, "Old");
    clock.set(clock.nowMs() + 2_000);
    const sender = await cache.senderOf(userId);
    assert.deepEqual([sender.nickname, sender.level, sender.userId], ["New", 1, userId]);
    await assert.rejects(cache.senderOf("00000000-0000-0000-0000-000000000000"), (e: unknown) => e instanceof AppError && e.errorCode === "UNAUTHORIZED");
  });

  it("shows a new nickname or avatar in the very next message (the profile service drops the cached entry)", async () => {
    const services = createTestServices();
    const { userId } = await services.auth.deviceLogin({ deviceId: "device-chat-rename", platform: "test" });
    const cache = new ChatProfileCache(services.profileRepository, fixedClock(Date.UTC(2026, 9, 21, 12, 0, 0)));
    services.profiles.onProfileChanged((changed) => cache.forget(changed));

    const before = (await cache.senderOf(userId)).nickname;
    await services.profiles.setNickname(userId, "Captain_Ana");
    assert.notEqual(before, "Captain_Ana");
    assert.equal((await cache.senderOf(userId)).nickname, "Captain_Ana", "no 30 second wait after a rename");
    await services.profiles.setAvatar(userId, "avatar_ghost");
    assert.equal((await cache.senderOf(userId)).avatarId, "avatar_ghost");
  });
});
