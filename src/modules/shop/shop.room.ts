// Room `shop`: the offers and buying them. One request type (`shop`) multiplexed by `type`.

import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { id, strictPayload } from "../../shared/validation.js";
import type { ShopService } from "./shop.service.js";

export const ShopMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info") }),
  strictPayload({ type: z.literal("buy"), offerId: id(64) }),
]);

export type ShopMessage = z.infer<typeof ShopMessageSchema>;

const ACTIONS = new Set(["info", "buy"]);

export class ShopState extends Schema {}

export type ShopRoomDeps = {
  shop: ShopService;
  /** Per-user limiter for `info`. */
  queryLimiter: RateLimiter;
  /** Per-user limiter for purchases. */
  buyLimiter: RateLimiter;
};

export class ShopRoom extends AuthenticatedRoom<ShopState, ShopRoomDeps> {
  state = new ShopState();

  onCreate(): void {
    this.handleAuthenticatedRequest<ShopMessage>("shop", {
      schema: ShopMessageSchema,
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
        const limiter = message.type === "info" ? this.deps.queryLimiter : this.deps.buyLimiter;
        if (!(await limiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        switch (message.type) {
          case "info":
            return { action: "info", ok: true, ...(await this.deps.shop.info(userId)) };
          case "buy":
            return { action: "buy", ok: true, ...(await this.deps.shop.buy(userId, message.offerId)) };
        }
      },
    });
  }
}
