// Room `tower`: event towers. One request type (`tower`) multiplexed by `type`. The floors are played in the `battle`
// room (join options `{ mode: "tower", target: "towerId:floor" }`).

import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { boundedString, strictPayload } from "../../shared/validation.js";
import type { TowerService } from "./tower.service.js";

const lang = boundedString(16).optional();

export const TowerMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info"), lang }),
]);

export type TowerMessage = z.infer<typeof TowerMessageSchema>;

const ACTIONS = new Set(["info"]);

export class TowerState extends Schema {}

export type TowerRoomDeps = {
  tower: TowerService;
  /** Per-user limiter for `info`. */
  queryLimiter: RateLimiter;
};

export class TowerRoom extends AuthenticatedRoom<TowerState, TowerRoomDeps> {
  state = new TowerState();

  onCreate(): void {
    this.handleAuthenticatedRequest<TowerMessage>("tower", {
      schema: TowerMessageSchema,
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
        if (!(await this.deps.queryLimiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        switch (message.type) {
          case "info":
            return { action: "info", ok: true, ...(await this.deps.tower.info(userId, message.lang)) };
        }
      },
    });
  }
}
