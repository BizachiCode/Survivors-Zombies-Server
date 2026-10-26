// Rooms `objectives` (missions, achievements, events) and `daily` (login calendar). One request type per room,
// multiplexed by `type`.

import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { LanguageSchema } from "../../shared/localized.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { id, strictPayload } from "../../shared/validation.js";
import type { DailyRewardService } from "./daily-rewards.service.js";
import { OBJECTIVE_KINDS } from "./objectives-content.js";
import type { ObjectiveService } from "./objectives.service.js";

function errorFormatter(actions: Set<string>) {
  return (failure: { error: string; extra?: unknown }, raw: unknown) => {
    const type = (raw as { type?: unknown } | null)?.type;
    return {
      action: typeof type === "string" && actions.has(type) ? type : "unknown",
      ok: false,
      error: failure.error,
      ...(failure.extra ? { extra: failure.extra } : {}),
    };
  };
}

export const ObjectivesMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info"), lang: LanguageSchema }),
  strictPayload({ type: z.literal("claim"), objectiveId: id(64), lang: LanguageSchema }),
  strictPayload({ type: z.literal("claim_all"), kind: z.enum(OBJECTIVE_KINDS).optional(), lang: LanguageSchema }),
]);
export type ObjectivesMessage = z.infer<typeof ObjectivesMessageSchema>;

export class ObjectivesState extends Schema {}

export type ObjectivesRoomDeps = { objectives: ObjectiveService; queryLimiter: RateLimiter; claimLimiter: RateLimiter };

export class ObjectivesRoom extends AuthenticatedRoom<ObjectivesState, ObjectivesRoomDeps> {
  state = new ObjectivesState();

  onCreate(): void {
    this.handleAuthenticatedRequest<ObjectivesMessage>("objectives", {
      schema: ObjectivesMessageSchema,
      formatError: errorFormatter(new Set(["info", "claim", "claim_all"])),
      handle: async ({ userId }, message) => {
        const limiter = message.type === "info" ? this.deps.queryLimiter : this.deps.claimLimiter;
        if (!(await limiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        switch (message.type) {
          case "info":
            return { action: "info", ok: true, ...(await this.deps.objectives.info(userId, message.lang)) };
          case "claim":
            return { action: "claim", ok: true, ...(await this.deps.objectives.claim(userId, message.objectiveId, message.lang)) };
          case "claim_all":
            return { action: "claim_all", ok: true, ...(await this.deps.objectives.claimAll(userId, message.kind, message.lang)) };
        }
      },
    });
  }
}

export const DailyMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info") }),
  strictPayload({ type: z.literal("claim") }),
]);
export type DailyMessage = z.infer<typeof DailyMessageSchema>;

export class DailyState extends Schema {}

export type DailyRoomDeps = { daily: DailyRewardService; queryLimiter: RateLimiter; claimLimiter: RateLimiter };

export class DailyRoom extends AuthenticatedRoom<DailyState, DailyRoomDeps> {
  state = new DailyState();

  onCreate(): void {
    this.handleAuthenticatedRequest<DailyMessage>("daily", {
      schema: DailyMessageSchema,
      formatError: errorFormatter(new Set(["info", "claim"])),
      handle: async ({ userId }, message) => {
        const limiter = message.type === "info" ? this.deps.queryLimiter : this.deps.claimLimiter;
        if (!(await limiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        return message.type === "info"
          ? { action: "info", ok: true, ...(await this.deps.daily.info(userId)) }
          : { action: "claim", ok: true, ...(await this.deps.daily.claim(userId)) };
      },
    });
  }
}
