// Room `chat`: live chat of one channel (`global`, or `clan:<clanId>` for the members of that clan). Requests (`chat`): `history` and `say`; the server relays every
// published message as a `message` broadcast. Like the battle room, nothing is pushed until the client asked for
// `history` (its handlers exist by then), and a dropped client has to ask again after reconnecting.

import { ServerError, type AuthContext, type Client } from "@colyseus/core";
import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom, type RoomIdentity } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { strictPayload } from "../../shared/validation.js";
import { CHAT_CHANNELS, DEFAULT_CHAT_CHANNEL } from "./chat-config.js";
import type { ChatProfileCache } from "./chat-profiles.js";
import type { ChatMessageDto, ChatService } from "./chat.service.js";

export const ChatMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("history") }),
  // The length rule (and the error code) is the service's; this cap only bounds what gets parsed.
  strictPayload({ type: z.literal("say"), text: z.string().max(2000) }),
]);

export type ChatRequest = z.infer<typeof ChatMessageSchema>;

const ACTIONS = new Set(["history", "say"]);

export class ChatState extends Schema {}

/**
 * Who may join a non-global channel. Clan channels (`clan:<clanId>`) are checked against the clan membership at
 * matchmaking (static `onAuth`, so it is module-level like the room authenticator) and again on `history` / `say`.
 */
export interface ChatChannelAccess {
  canJoin(userId: string, channel: string): Promise<boolean>;
}

let channelAccess: ChatChannelAccess | null = null;

/** Wires the membership check of the non-global channels (without it only `global` can be joined). */
export function configureChatChannelAccess(value: ChatChannelAccess | null): void {
  channelAccess = value;
}

const CLAN_CHANNEL = /^clan:[0-9a-f-]{8,64}$/;

export function isKnownChatChannel(channel: unknown): channel is string {
  return typeof channel === "string" && (CHAT_CHANNELS.includes(channel) || CLAN_CHANNEL.test(channel));
}

/** The membership of a non-global channel is re-checked at most this often per client. */
const ACCESS_RECHECK_MS = 5_000;

export type ChatRoomDeps = {
  chat: ChatService;
  profiles: ChatProfileCache;
  /** Per-user limiter for `history`. */
  historyLimiter: RateLimiter;
};

export type ChatIdentity = RoomIdentity & { channel: string };

export class ChatRoom extends AuthenticatedRoom<ChatState, ChatRoomDeps> {
  maxClients = 500;
  state = new ChatState();

  private channel = DEFAULT_CHAT_CHANNEL;
  private unsubscribe: (() => void) | null = null;

  /** Matchmaking check: the access token, then the channel (unknown → 400 INVALID_PAYLOAD). */
  static async onAuth(token: string, options: any, context: AuthContext): Promise<ChatIdentity | false> {
    const identity = await AuthenticatedRoom.onAuth(token, options, context);
    if (!identity) return false;
    const channel = options?.channel ?? DEFAULT_CHAT_CHANNEL;
    if (!isKnownChatChannel(channel)) throw new ServerError(400, ErrorCode.INVALID_PAYLOAD);
    if (!CHAT_CHANNELS.includes(channel) && !(channelAccess && (await channelAccess.canJoin(identity.userId, channel)))) {
      throw new ServerError(403, ErrorCode.CLAN_NOT_MEMBER);
    }
    return { ...identity, channel };
  }

  onCreate(options: any): void {
    this.channel = isKnownChatChannel(options?.channel) ? options.channel : DEFAULT_CHAT_CHANNEL;
    // Starts restoring the stored history now, so the first `history` request rarely waits for it.
    void this.deps.chat.ready(this.channel);
    // Nothing is synchronized through the state: messages travel as broadcasts.
    this.setPatchRate(null);
    this.unsubscribe = this.deps.chat.subscribe(this.channel, (message) => this.relay(message), (userId) => this.evict(userId));

    this.handleAuthenticatedRequest<ChatRequest>("chat", {
      schema: ChatMessageSchema,
      formatError: (failure, raw) => {
        const type = (raw as { type?: unknown } | null)?.type;
        return {
          action: typeof type === "string" && ACTIONS.has(type) ? type : "unknown",
          ok: false,
          error: failure.error,
          ...(failure.extra ? { extra: failure.extra } : {}),
        };
      },
      handle: async ({ client, userId }, message) => {
        await this.assertAccess(client, userId);
        if (message.type === "history") {
          if (!(await this.deps.historyLimiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
          await this.deps.chat.ready(this.channel);
          // Synchronous from here on: no message can slip between the snapshot and the first relayed one.
          (client.userData ??= {}).chatReady = true;
          return { action: "history", ok: true, messages: this.deps.chat.history(this.channel) };
        }
        const sender = await this.deps.profiles.senderOf(userId);
        await this.deps.chat.ready(this.channel);
        return { action: "say", ok: true, message: this.deps.chat.post(this.channel, sender, message.text) };
      },
    });
  }

  onDrop(client: Client): void {
    (client.userData ??= {}).chatReady = false;
    this.allowReconnection(client, 30);
  }

  onDispose(): void {
    this.unsubscribe?.();
  }

  /** Non-global channels: the player must still be a member (a kick / leave closes the channel for them within seconds). */
  private async assertAccess(client: Client, userId: string): Promise<void> {
    if (CHAT_CHANNELS.includes(this.channel)) return;
    const userData = (client.userData ??= {}) as { accessCheckedAt?: number };
    const now = Date.now();
    if (userData.accessCheckedAt && now - userData.accessCheckedAt < ACCESS_RECHECK_MS) return;
    if (!(channelAccess && (await channelAccess.canJoin(userId, this.channel)))) {
      this.evict(userId);
      throw new AppError(ErrorCode.CLAN_NOT_MEMBER);
    }
    userData.accessCheckedAt = now;
  }

  /** Removes the user's clients from the room (`null` = everybody: the channel was closed). */
  private evict(userId: string | null): void {
    for (const client of [...this.clients]) {
      if (userId !== null && (client.auth as RoomIdentity | undefined)?.userId !== userId) continue;
      (client.userData ??= {}).chatReady = false;
      client.send("evicted", {});
      // CONSENTED (4000): the SDK treats it as a deliberate leave and does not try to reconnect.
      client.leave(4000);
    }
  }

  private relay(message: ChatMessageDto): void {
    for (const client of this.clients) {
      if ((client.userData as { chatReady?: boolean } | undefined)?.chatReady) client.send("message", message);
    }
  }
}
