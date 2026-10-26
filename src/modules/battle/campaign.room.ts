// Room `campaign`: the stage list with the player's stars and unlocks (the map screen). One request type (`campaign`)
// multiplexed by `type`.

import { Schema } from "@colyseus/schema";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { BattleService } from "./battle.service.js";
import { CampaignMessageSchema, type CampaignMessage } from "./battle.validation.js";

export class CampaignState extends Schema {}

export type CampaignRoomDeps = {
  battles: BattleService;
  queryLimiter: RateLimiter;
};

export class CampaignRoom extends AuthenticatedRoom<CampaignState, CampaignRoomDeps> {
  state = new CampaignState();

  onCreate(): void {
    this.handleAuthenticatedRequest<CampaignMessage>("campaign", {
      schema: CampaignMessageSchema,
      formatError: (failure) => ({ action: "info", ok: false, error: failure.error }),
      handle: async ({ userId }, message) => {
        if (!(await this.deps.queryLimiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        return { action: "info", ok: true, ...(await this.deps.battles.campaign(userId, message.lang)) };
      },
    });
  }
}
