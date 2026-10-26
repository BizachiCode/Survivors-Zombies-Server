// Where the chat history of each channel is kept between restarts (CHAT_HISTORY_STORE in .env): the database (default),
// Redis, or this process's memory only. The chat service always serves the history from memory; a store only restores it
// when a channel is first used and receives every new message.

import { and, desc, eq, lte } from "drizzle-orm";
import type Redis from "ioredis";

import type { Database } from "../../infrastructure/database/drizzle.js";
import { DrizzleRepository } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { chatMessages } from "../../infrastructure/database/schema/chat.schema.js";
import { parseJsonColumn } from "../../shared/content/localized-text.js";
import type { ChatMessageDto } from "./chat.service.js";

export type ChatHistoryStoreKind = "db" | "redis" | "memory";

export interface ChatHistoryStore {
  /** false = nothing survives a restart (the memory store): channels need no loading. */
  readonly persistent: boolean;
  /** The last `limit` messages of the channel, oldest first. */
  load(channelId: string, limit: number): Promise<ChatMessageDto[]>;
  /** Stores a new message and drops the ones older than the last `limit`. */
  append(channelId: string, message: ChatMessageDto, limit: number): Promise<void>;
  /** Forgets the channel (a deleted clan). */
  clear(channelId: string): Promise<void>;
}

/** History in this process only (lost on restart): the chat service's own memory is the history. */
export class MemoryChatHistoryStore implements ChatHistoryStore {
  readonly persistent = false;
  async load(): Promise<ChatMessageDto[]> { return []; }
  async append(): Promise<void> {}
  async clear(): Promise<void> {}
}

/** History in Redis: one list per channel (`chat:history:<channel>`, after REDIS_KEY_PREFIX), trimmed to the last messages. */
export class RedisChatHistoryStore implements ChatHistoryStore {
  readonly persistent = true;

  constructor(private readonly redis: Redis) {}

  private key(channelId: string): string {
    return `chat:history:${channelId}`;
  }

  async load(channelId: string, limit: number): Promise<ChatMessageDto[]> {
    const raw = await this.redis.lrange(this.key(channelId), -limit, -1);
    return raw.map((entry) => JSON.parse(entry) as ChatMessageDto);
  }

  async append(channelId: string, message: ChatMessageDto, limit: number): Promise<void> {
    await this.redis.multi().rpush(this.key(channelId), JSON.stringify(message)).ltrim(this.key(channelId), -limit, -1).exec();
  }

  async clear(channelId: string): Promise<void> {
    await this.redis.del(this.key(channelId));
  }
}

/** History in the database (table `chat_messages`): each channel keeps its last messages, older rows are deleted. */
export class DrizzleChatHistoryStore extends DrizzleRepository implements ChatHistoryStore {
  readonly persistent = true;

  constructor(database: Database) {
    super(database);
  }

  async load(channelId: string, limit: number): Promise<ChatMessageDto[]> {
    const rows = await this.db().select().from(chatMessages)
      .where(eq(chatMessages.channel, channelId))
      .orderBy(desc(chatMessages.messageId)).limit(limit);
    return rows.reverse().map((row) => ({
      id: String(row.messageId),
      userId: row.userId,
      nickname: row.nickname,
      avatarId: row.avatarId,
      level: row.level,
      text: row.text,
      atUnix: row.atUnix,
      system: row.system,
      ...(row.textKey ? { key: row.textKey, args: parseJsonColumn<string[] | null>(row.args) ?? [] } : {}),
    }));
  }

  async append(channelId: string, message: ChatMessageDto, limit: number): Promise<void> {
    const messageId = Number(message.id);
    await this.db().insert(chatMessages).values({
      channel: channelId,
      messageId,
      userId: message.userId,
      nickname: message.nickname,
      avatarId: message.avatarId,
      level: message.level,
      text: message.text,
      system: message.system,
      textKey: message.key ?? null,
      args: message.key ? (message.args ?? []) : null,
      atUnix: message.atUnix,
    });
    // Message ids grow inside a channel, so everything at or below `id - limit` is older than the kept history.
    if (messageId > limit) {
      await this.db().delete(chatMessages).where(and(eq(chatMessages.channel, channelId), lte(chatMessages.messageId, messageId - limit)));
    }
  }

  async clear(channelId: string): Promise<void> {
    await this.db().delete(chatMessages).where(eq(chatMessages.channel, channelId));
  }
}
