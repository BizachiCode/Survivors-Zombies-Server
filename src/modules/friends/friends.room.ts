// Room `friends`: friend list, requests, daily gifts and player cards. One request type (`friends`) multiplexed by `type`.

import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { boundedString, strictPayload } from "../../shared/validation.js";
import type { FriendsService } from "./friends.service.js";

/** Friend code as typed by a player: surrounding spaces are ignored and the digits are case-insensitive (checked by the service). */
const code = boundedString(16, 1);

export const FriendsMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info") }),
  strictPayload({ type: z.literal("request"), code }),
  strictPayload({ type: z.literal("accept"), code }),
  strictPayload({ type: z.literal("decline"), code }),
  strictPayload({ type: z.literal("cancel"), code }),
  strictPayload({ type: z.literal("remove"), code }),
  strictPayload({ type: z.literal("send_gift"), code }),
  strictPayload({ type: z.literal("claim_gifts") }),
  strictPayload({ type: z.literal("player"), code }),
]);

export type FriendsMessage = z.infer<typeof FriendsMessageSchema>;

const ACTIONS = new Set(["info", "request", "accept", "decline", "cancel", "remove", "send_gift", "claim_gifts", "player"]);

export class FriendsState extends Schema {}

export type FriendsRoomDeps = {
  friends: FriendsService;
  /** Per-user limiter for `info` and `player`. */
  queryLimiter: RateLimiter;
  /** Per-user limiter for everything that changes something. */
  changeLimiter: RateLimiter;
};

export class FriendsRoom extends AuthenticatedRoom<FriendsState, FriendsRoomDeps> {
  state = new FriendsState();

  onCreate(): void {
    this.handleAuthenticatedRequest<FriendsMessage>("friends", {
      schema: FriendsMessageSchema,
      formatError: (failure, raw) => {
        const type = (raw as { type?: unknown } | null)?.type;
        return {
          action: typeof type === "string" && ACTIONS.has(type) ? type : "unknown",
          ok: false,
          error: failure.error,
          ...(failure.extra ? { extra: failure.extra } : {}),
        };
      },
      handle: async ({ userId }, message) => {
        const query = message.type === "info" || message.type === "player";
        if (!(await (query ? this.deps.queryLimiter : this.deps.changeLimiter).allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        const { friends } = this.deps;
        switch (message.type) {
          case "info":
            return { action: "info", ok: true, ...(await friends.info(userId)) };
          case "request":
            return { action: "request", ok: true, ...(await friends.request(userId, message.code)) };
          case "accept":
            return { action: "accept", ok: true, ...(await friends.accept(userId, message.code)) };
          case "decline":
            return { action: "decline", ok: true, ...(await friends.decline(userId, message.code)) };
          case "cancel":
            return { action: "cancel", ok: true, ...(await friends.cancel(userId, message.code)) };
          case "remove":
            return { action: "remove", ok: true, ...(await friends.remove(userId, message.code)) };
          case "send_gift":
            return { action: "send_gift", ok: true, ...(await friends.sendGift(userId, message.code)) };
          case "claim_gifts":
            return { action: "claim_gifts", ok: true, ...(await friends.claimGifts(userId)) };
          case "player":
            return { action: "player", ok: true, ...(await friends.player(userId, message.code)) };
        }
      },
    });
  }
}
