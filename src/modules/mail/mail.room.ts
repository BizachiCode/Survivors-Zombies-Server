// Room `mail`: the inbox. One request type (`mail`) multiplexed by `type`.

import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { boundedString, id, strictPayload } from "../../shared/validation.js";
import type { MailService } from "./mail.service.js";

const lang = boundedString(16).optional();

export const MailMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info"), lang }),
  strictPayload({ type: z.literal("read"), mailId: id(64), lang }),
  strictPayload({ type: z.literal("claim"), mailId: id(64), lang }),
  strictPayload({ type: z.literal("claim_all"), lang }),
  strictPayload({ type: z.literal("delete"), mailId: id(64), lang }),
]);

export type MailMessage = z.infer<typeof MailMessageSchema>;

const ACTIONS = new Set(["info", "read", "claim", "claim_all", "delete"]);

export class MailState extends Schema {}

export type MailRoomDeps = {
  mail: MailService;
  /** Per-user limiter for `info`. */
  queryLimiter: RateLimiter;
  /** Per-user limiter for read / claim / delete. */
  changeLimiter: RateLimiter;
};

export class MailRoom extends AuthenticatedRoom<MailState, MailRoomDeps> {
  state = new MailState();

  onCreate(): void {
    this.handleAuthenticatedRequest<MailMessage>("mail", {
      schema: MailMessageSchema,
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
        const { mail } = this.deps;
        switch (message.type) {
          case "info":
            return { action: "info", ok: true, ...(await mail.info(userId, message.lang)) };
          case "read":
            return { action: "read", ok: true, ...(await mail.read(userId, message.mailId, message.lang)) };
          case "claim":
            return { action: "claim", ok: true, ...(await mail.claim(userId, message.mailId, message.lang)) };
          case "claim_all":
            return { action: "claim_all", ok: true, ...(await mail.claimAll(userId, message.lang)) };
          case "delete":
            return { action: "delete", ok: true, ...(await mail.delete(userId, message.mailId, message.lang)) };
        }
      },
    });
  }
}
