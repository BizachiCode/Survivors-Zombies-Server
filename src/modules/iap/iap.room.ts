// Room `iap`: real-money products and receipt verification. One request type (`iap`) multiplexed by `type`.

import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { id, strictPayload } from "../../shared/validation.js";
import type { IapService } from "./iap.service.js";
import { IAP_STORES } from "./validators/receipt.js";

export const IapMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info") }),
  strictPayload({
    type: z.literal("verify"),
    store: z.enum(IAP_STORES),
    productId: id(64),
    /** Unity IAP unified receipt (`order.Info.Receipt`). */
    receipt: z.string().min(2).max(32_000),
    /** StoreKit 2 signed transaction (`order.Info.Apple.jwsRepresentation`). */
    jws: z.string().max(32_000).optional(),
  }),
]);

export type IapMessage = z.infer<typeof IapMessageSchema>;

const ACTIONS = new Set(["info", "verify"]);

export class IapState extends Schema {}

export type IapRoomDeps = {
  iap: IapService;
  queryLimiter: RateLimiter;
  verifyLimiter: RateLimiter;
};

export class IapRoom extends AuthenticatedRoom<IapState, IapRoomDeps> {
  state = new IapState();

  onCreate(): void {
    this.handleAuthenticatedRequest<IapMessage>("iap", {
      schema: IapMessageSchema,
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
        const limiter = message.type === "info" ? this.deps.queryLimiter : this.deps.verifyLimiter;
        if (!(await limiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        if (message.type === "info") return { action: "info", ok: true, ...(await this.deps.iap.info(userId)) };
        const { store, productId, receipt, jws } = message;
        return { action: "verify", ok: true, ...(await this.deps.iap.verify(userId, { store, productId, receipt, jws })) };
      },
    });
  }
}
