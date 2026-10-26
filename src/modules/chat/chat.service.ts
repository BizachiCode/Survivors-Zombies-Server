// Chat rules without any transport: text normalization, the word filter, spam / mute bookkeeping per user, one history
// per channel and the fan-out to the rooms listening to a channel. The room only authenticates and relays.
// The history is served from memory; a persistent store (database or Redis, see chat-history.ts) restores it when a
// channel is first used and receives every new message, so it survives restarts.

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import { publicUserId } from "../../shared/kernel/public-id.js";
import { createLogger } from "../../shared/logger.js";
import { TokenBucketRateLimiter } from "../../shared/security/rate-limiter.js";
import { DEFAULT_CHAT_CONFIG, type ChatConfig } from "./chat-config.js";
import { MemoryChatHistoryStore, type ChatHistoryStore } from "./chat-history.js";

const logger = createLogger("Chat");

export type ChatMessageDto = {
  /** Unique inside the channel and growing (`0` = the welcome line). */
  id: string;
  /** Public id of the sender (first 8 hex digits of the user id); empty for system messages. */
  userId: string;
  nickname: string;
  avatarId: string;
  level: number;
  text: string;
  atUnix: number;
  system: boolean;
  /** System lines: translation key and arguments for the client (`text` is the English line). */
  key?: string;
  args?: string[];
};

export type ChatSender = {
  userId: string;
  nickname: string;
  avatarId: string;
  level: number;
};

type Speaker = {
  mutedUntilMs: number;
  lastText: string;
  repeats: number;
  lastSeenMs: number;
};

type Channel = {
  history: ChatMessageDto[];
  nextId: number;
  listeners: Set<(message: ChatMessageDto) => void>;
  /** Called when a user is removed from the channel (clan channels: kicked or left). `null` = everybody (the channel closed). */
  evictors: Set<(userId: string | null) => void>;
  /** Restoring the stored history (persistent stores only); null once the channel is ready. */
  loading: Promise<void> | null;
};

/** Idle speakers are forgotten after this long (their mute, if any, has expired by then). */
const SPEAKER_IDLE_MS = 10 * 60_000;
const SWEEP_EVERY_POSTS = 500;

export class ChatService {
  private readonly channels = new Map<string, Channel>();
  private readonly speakers = new Map<string, Speaker>();
  private readonly rate: TokenBucketRateLimiter;
  private readonly profanity: RegExp | null;
  private posts = 0;

  constructor(
    private readonly clock: Clock,
    private readonly config: ChatConfig = DEFAULT_CHAT_CONFIG,
    private readonly store: ChatHistoryStore = new MemoryChatHistoryStore(),
  ) {
    this.rate = new TokenBucketRateLimiter({
      tokensPerInterval: 1,
      intervalMs: config.rate.intervalMs,
      burst: config.rate.burst,
      now: () => clock.nowMs(),
    });
    this.profanity = buildProfanityFilter(config.profanity);
  }

  /** Trims, collapses whitespace and strips control / format characters; empty or too long text is refused. */
  normalize(raw: string): string {
    const text = raw.replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, "").trim();
    if (text.length === 0 || [...text].length > this.config.maxLength) throw new AppError(ErrorCode.CHAT_INVALID_MESSAGE);
    return text;
  }

  /** Masks the letters of filtered words with `*` (same length). */
  filter(text: string): string {
    return this.profanity ? text.replace(this.profanity, (word) => word.replace(/[\p{L}\p{N}]/gu, "*")) : text;
  }

  /**
   * Restores the stored history of the channel (once, with a persistent store). Await it before `history` and `post`:
   * from then on they are synchronous. A store that can't be read leaves the channel with an empty history.
   */
  async ready(channelId: string): Promise<void> {
    const loading = this.channel(channelId).loading;
    if (loading) await loading;
  }

  /**
   * Validates and publishes a message of `sender` to everybody listening to `channel`, and returns it.
   * Errors: CHAT_MUTED (extra.untilUnix), RATE_LIMIT, CHAT_INVALID_MESSAGE.
   */
  post(channelId: string, sender: ChatSender, rawText: string): ChatMessageDto {
    const nowMs = this.clock.nowMs();
    this.sweep(nowMs);
    const speaker = this.speaker(sender.userId, nowMs);
    this.assertNotMuted(speaker, nowMs);
    const text = this.normalize(rawText);
    if (!this.rate.allow(sender.userId)) throw new AppError(ErrorCode.RATE_LIMIT);

    const signature = text.toLowerCase();
    speaker.repeats = signature === speaker.lastText ? speaker.repeats + 1 : 1;
    speaker.lastText = signature;
    if (speaker.repeats >= this.config.repeatLimit) {
      speaker.mutedUntilMs = nowMs + this.config.muteSeconds * 1000;
      speaker.lastText = "";
      speaker.repeats = 0;
      this.assertNotMuted(speaker, nowMs);
    }

    const channel = this.readyChannel(channelId);
    const message: ChatMessageDto = {
      id: String(channel.nextId++),
      userId: publicUserId(sender.userId),
      nickname: sender.nickname,
      avatarId: sender.avatarId,
      level: sender.level,
      text: this.filter(text),
      atUnix: Math.floor(nowMs / 1000),
      system: false,
    };
    this.publish(channelId, channel, message);
    return message;
  }

  /** The welcome line followed by the last messages of the channel, oldest first. */
  history(channelId: string): ChatMessageDto[] {
    const text = channelId.startsWith("clan:") ? (this.config.clanWelcome ?? this.config.welcome) : this.config.welcome;
    const welcome: ChatMessageDto = {
      id: "0", userId: "", nickname: "", avatarId: "", level: 0, text, atUnix: this.clock.nowUnix(), system: true,
    };
    return [welcome, ...this.readyChannel(channelId).history];
  }

  /**
   * A system line (no sender, e.g. "Ana joined the clan.") published to everybody listening to the channel. It is part of
   * the history like any message, but spam / mute rules do not apply. On a channel whose stored history is still loading
   * it is published once loaded (and `null` is returned).
   */
  postSystem(channelId: string, text: string, key?: string, args?: string[]): ChatMessageDto | null {
    const channel = this.channel(channelId);
    if (channel.loading) {
      void channel.loading.then(() => this.postSystem(channelId, text, key, args));
      return null;
    }
    const message: ChatMessageDto = {
      id: String(channel.nextId++), userId: "", nickname: "", avatarId: "", level: 0, text, atUnix: this.clock.nowUnix(), system: true,
      ...(key ? { key, args: args ?? [] } : {}),
    };
    this.publish(channelId, channel, message);
    return message;
  }

  /** Calls `listener` with every message published to the channel (rooms relay them to their clients). Returns the unsubscribe function. */
  subscribe(channelId: string, listener: (message: ChatMessageDto) => void, onEvict?: (userId: string | null) => void): () => void {
    const channel = this.channel(channelId);
    channel.listeners.add(listener);
    if (onEvict) channel.evictors.add(onEvict);
    return () => {
      channel.listeners.delete(listener);
      if (onEvict) channel.evictors.delete(onEvict);
    };
  }

  /** Disconnects `userId` from the channel's rooms (they stop receiving and can not `say`). */
  evict(channelId: string, userId: string): void {
    const channel = this.channels.get(channelId);
    if (channel) for (const evictor of channel.evictors) evictor(userId);
  }

  /** Disconnects everybody from the channel and forgets its history (a deleted clan), stored copy included. */
  closeChannel(channelId: string): void {
    this.store.clear(channelId).catch((error) => logger.error(`could not clear the stored history of ${channelId}:`, (error as Error).message));
    const channel = this.channels.get(channelId);
    if (!channel) return;
    for (const evictor of channel.evictors) evictor(null);
    this.channels.delete(channelId);
  }

  private channel(channelId: string): Channel {
    let channel = this.channels.get(channelId);
    if (!channel) {
      channel = { history: [], nextId: 1, listeners: new Set(), evictors: new Set(), loading: null };
      this.channels.set(channelId, channel);
      if (this.store.persistent) channel.loading = this.restore(channelId, channel);
    }
    return channel;
  }

  /** The channel, which must be loaded (callers await `ready` first). */
  private readyChannel(channelId: string): Channel {
    const channel = this.channel(channelId);
    if (channel.loading) throw new Error(`Chat channel ${channelId} is still loading its history: await ready() first.`);
    return channel;
  }

  private async restore(channelId: string, channel: Channel): Promise<void> {
    try {
      const stored = await this.store.load(channelId, this.config.historySize);
      channel.history = stored.slice(-this.config.historySize);
      // New messages continue the stored ids (clients tell messages apart by id).
      channel.nextId = stored.reduce((next, message) => Math.max(next, Number(message.id) + 1), 1);
    } catch (error) {
      logger.error(`could not load the stored history of ${channelId} (starting empty):`, (error as Error).message);
    } finally {
      channel.loading = null;
    }
  }

  /** Adds the message to the history, stores it and relays it to the rooms of the channel. */
  private publish(channelId: string, channel: Channel, message: ChatMessageDto): void {
    channel.history.push(message);
    if (channel.history.length > this.config.historySize) channel.history.splice(0, channel.history.length - this.config.historySize);
    this.store.append(channelId, message, this.config.historySize)
      .catch((error) => logger.error(`could not store a message of ${channelId}:`, (error as Error).message));
    for (const listener of channel.listeners) listener(message);
  }

  private speaker(userId: string, nowMs: number): Speaker {
    let speaker = this.speakers.get(userId);
    if (!speaker) {
      speaker = { mutedUntilMs: 0, lastText: "", repeats: 0, lastSeenMs: nowMs };
      this.speakers.set(userId, speaker);
    }
    speaker.lastSeenMs = nowMs;
    return speaker;
  }

  private assertNotMuted(speaker: Speaker, nowMs: number): void {
    if (speaker.mutedUntilMs > nowMs) {
      throw new AppError(ErrorCode.CHAT_MUTED, { extra: { untilUnix: Math.ceil(speaker.mutedUntilMs / 1000) } });
    }
  }

  private sweep(nowMs: number): void {
    if (++this.posts % SWEEP_EVERY_POSTS !== 0) return;
    for (const [userId, speaker] of this.speakers) {
      if (nowMs - speaker.lastSeenMs > SPEAKER_IDLE_MS && speaker.mutedUntilMs <= nowMs) this.speakers.delete(userId);
    }
  }
}

/** Case-insensitive, whole-word matcher of the list (a word is a run of letters / digits). */
function buildProfanityFilter(words: readonly string[]): RegExp | null {
  const escaped = words.filter((word) => word.length > 0).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}
