// Room `news`: the announcements. One request type (`news`) multiplexed by `type`.

import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { boundedString, strictPayload } from "../../shared/validation.js";
import type { NewsService } from "./news.service.js";

export const NewsMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info"), lang: boundedString(16).optional() }),
]);

export type NewsMessage = z.infer<typeof NewsMessageSchema>;

export class NewsState extends Schema {}

export type NewsRoomDeps = {
  news: NewsService;
  /** Per-user limiter. */
  queryLimiter: RateLimiter;
};

export class NewsRoom extends AuthenticatedRoom<NewsState, NewsRoomDeps> {
  state = new NewsState();

  onCreate(): void {
    this.handleAuthenticatedRequest<NewsMessage>("news", {
      schema: NewsMessageSchema,
      formatError: (failure) => ({
        action: "info",
        ok: false,
        error: failure.error,
        ...(failure.extra ? { extra: failure.extra } : {}),
      }),
      handle: async ({ userId }, message) => {
        if (!(await this.deps.queryLimiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        return { action: "info", ok: true, items: this.deps.news.info(message.lang) };
      },
    });
  }
}
