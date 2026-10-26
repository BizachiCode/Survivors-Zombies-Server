// Room `ranking`: the leaderboards. One request type (`ranking`).

import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { id, strictPayload } from "../../shared/validation.js";
import type { RankingService } from "./ranking.service.js";

export const RankingMessageSchema = strictPayload({ type: z.literal("info"), board: id(32) });

export type RankingMessage = z.infer<typeof RankingMessageSchema>;

export class RankingState extends Schema {}

export type RankingRoomDeps = {
  rankings: RankingService;
  /** Per-user limiter for `info`. */
  queryLimiter: RateLimiter;
};

export class RankingRoom extends AuthenticatedRoom<RankingState, RankingRoomDeps> {
  state = new RankingState();

  onCreate(): void {
    this.handleAuthenticatedRequest<RankingMessage>("ranking", {
      schema: RankingMessageSchema,
      formatError: (failure, raw) => {
        const type = (raw as { type?: unknown } | null)?.type;
        return {
          action: type === "info" ? type : "unknown",
          ok: false,
          error: failure.error,
          ...(failure.extra ? { extra: failure.extra } : {}),
        };
      },
      handle: async ({ userId }, message) => {
        if (!(await this.deps.queryLimiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        return { action: "info", ok: true, ...(await this.deps.rankings.info(userId, message.board)) };
      },
    });
  }
}
