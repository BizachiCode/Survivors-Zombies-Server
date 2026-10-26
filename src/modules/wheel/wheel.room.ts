// Room `wheel`: the lucky wheel. One request type (`wheel`) multiplexed by `type`.

import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { strictPayload } from "../../shared/validation.js";
import type { WheelService } from "./wheel.service.js";

export const WheelMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info") }),
  strictPayload({ type: z.literal("spin") }),
]);

export type WheelMessage = z.infer<typeof WheelMessageSchema>;

const ACTIONS = new Set(["info", "spin"]);

export class WheelState extends Schema {}

export type WheelRoomDeps = {
  wheel: WheelService;
  /** Per-user limiter for `info`. */
  queryLimiter: RateLimiter;
  /** Per-user limiter for `spin`. */
  spinLimiter: RateLimiter;
};

export class WheelRoom extends AuthenticatedRoom<WheelState, WheelRoomDeps> {
  state = new WheelState();

  onCreate(): void {
    this.handleAuthenticatedRequest<WheelMessage>("wheel", {
      schema: WheelMessageSchema,
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
        const limiter = message.type === "info" ? this.deps.queryLimiter : this.deps.spinLimiter;
        if (!(await limiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        switch (message.type) {
          case "info":
            return { action: "info", ok: true, ...(await this.deps.wheel.info(userId)) };
          case "spin":
            return { action: "spin", ok: true, ...(await this.deps.wheel.spin(userId)) };
        }
      },
    });
  }
}
