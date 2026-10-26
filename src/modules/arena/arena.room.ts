// Room `arena`: the player's league, tickets and group this season. One request type (`arena`) multiplexed by `type`.
// Matches are battles of mode "arena" in the `battle` room.

import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { LanguageSchema } from "../../shared/localized.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { strictPayload } from "../../shared/validation.js";
import type { ArenaService } from "./arena.service.js";

export const ArenaMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info"), lang: LanguageSchema }),
  strictPayload({ type: z.literal("buy_ticket"), lang: LanguageSchema }),
]);

export type ArenaMessage = z.infer<typeof ArenaMessageSchema>;

const ACTIONS = new Set(["info", "buy_ticket"]);

export class ArenaState extends Schema {}

export type ArenaRoomDeps = { arena: ArenaService; queryLimiter: RateLimiter; changeLimiter: RateLimiter };

export class ArenaRoom extends AuthenticatedRoom<ArenaState, ArenaRoomDeps> {
  state = new ArenaState();

  onCreate(): void {
    this.handleAuthenticatedRequest<ArenaMessage>("arena", {
      schema: ArenaMessageSchema,
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
        const limiter = message.type === "info" ? this.deps.queryLimiter : this.deps.changeLimiter;
        if (!(await limiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        if (message.type === "info") return { action: "info", ok: true, ...(await this.deps.arena.info(userId, message.lang)) };
        return { action: "buy_ticket", ok: true, ...(await this.deps.arena.buyTicket(userId, message.lang)) };
      },
    });
  }
}
