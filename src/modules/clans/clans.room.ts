// Room `clan`: my clan, search, create / join / leave, roles, ranking of clans and token donations. One request type
// (`clan`) multiplexed by `type`. The clan chat is the `chat` room with channel `clan:<clanId>` (see clan-chat.ts).

import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { boundedString, strictPayload } from "../../shared/validation.js";
import { CLAN_TYPES } from "./clans-config.js";
import type { ClansService } from "./clans.service.js";

/** Public tag as typed by a player (`#qx7r2k` is fine): normalized by the service. */
const tag = boundedString(16, 1);
/** Public player id. */
const code = boundedString(16, 1);
/**
 * Only size guards here: the exact rules (name, description length, emblem ids, minimum level, donation amount) are
 * checked by the service against CLANS_CONFIG / CLAN_BADGES, so raising a limit there is enough.
 */
const name = z.string().max(64);
const description = z.string().max(1000);
const badge = boundedString(32, 1);
const type = z.enum(CLAN_TYPES);
const minLevel = z.number().int().min(0).max(100_000);

export const ClanMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info") }),
  strictPayload({ type: z.literal("search"), query: boundedString(32, 1) }),
  strictPayload({ type: z.literal("create"), name, description, badge, clanType: type, minLevel }),
  strictPayload({ type: z.literal("join"), tag }),
  strictPayload({ type: z.literal("cancel_request") }),
  strictPayload({ type: z.literal("accept"), code }),
  strictPayload({ type: z.literal("decline"), code }),
  strictPayload({ type: z.literal("leave") }),
  strictPayload({ type: z.literal("kick"), code }),
  strictPayload({ type: z.literal("promote"), code }),
  strictPayload({ type: z.literal("demote"), code }),
  strictPayload({ type: z.literal("edit"), description, badge, clanType: type, minLevel }),
  strictPayload({ type: z.literal("view"), tag }),
  strictPayload({ type: z.literal("ranking") }),
  strictPayload({ type: z.literal("request_donation"), itemId: boundedString(64, 1), amount: z.number().int().min(1).max(100_000).optional() }),
  strictPayload({ type: z.literal("donate"), code }),
]);

export type ClanMessage = z.infer<typeof ClanMessageSchema>;

const ACTIONS = new Set([
  "info", "search", "create", "join", "cancel_request", "accept", "decline", "leave", "kick", "promote", "demote", "edit", "view",
  "ranking", "request_donation", "donate",
]);
const QUERIES = new Set(["info", "search", "view", "ranking"]);

export class ClanState extends Schema {}

export type ClanRoomDeps = {
  clans: ClansService;
  /** Per-user limiter for `info`, `search`, `view` and `ranking`. */
  queryLimiter: RateLimiter;
  /** Per-user limiter for everything that changes something. */
  changeLimiter: RateLimiter;
};

export class ClanRoom extends AuthenticatedRoom<ClanState, ClanRoomDeps> {
  state = new ClanState();

  onCreate(): void {
    this.handleAuthenticatedRequest<ClanMessage>("clan", {
      schema: ClanMessageSchema,
      formatError: (failure, raw) => {
        const kind = (raw as { type?: unknown } | null)?.type;
        return {
          action: typeof kind === "string" && ACTIONS.has(kind) ? kind : "unknown",
          ok: false,
          error: failure.error,
          ...(failure.extra ? { extra: failure.extra } : {}),
        };
      },
      handle: async ({ userId }, message) => {
        const limiter = QUERIES.has(message.type) ? this.deps.queryLimiter : this.deps.changeLimiter;
        if (!(await limiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        const { clans } = this.deps;
        switch (message.type) {
          case "info":
            return { action: "info", ok: true, ...(await clans.info(userId)) };
          case "search":
            return { action: "search", ok: true, ...(await clans.search(userId, message.query)) };
          case "create":
            return {
              action: "create", ok: true,
              ...(await clans.create(userId, { name: message.name, description: message.description, badge: message.badge, type: message.clanType, minLevel: message.minLevel })),
            };
          case "join":
            return { action: "join", ok: true, ...(await clans.join(userId, message.tag)) };
          case "cancel_request":
            return { action: "cancel_request", ok: true, ...(await clans.cancelRequest(userId)) };
          case "accept":
            return { action: "accept", ok: true, ...(await clans.accept(userId, message.code)) };
          case "decline":
            return { action: "decline", ok: true, ...(await clans.decline(userId, message.code)) };
          case "leave":
            return { action: "leave", ok: true, ...(await clans.leave(userId)) };
          case "kick":
            return { action: "kick", ok: true, ...(await clans.kick(userId, message.code)) };
          case "promote":
            return { action: "promote", ok: true, ...(await clans.promote(userId, message.code)) };
          case "demote":
            return { action: "demote", ok: true, ...(await clans.demote(userId, message.code)) };
          case "edit":
            return {
              action: "edit", ok: true,
              ...(await clans.edit(userId, { description: message.description, badge: message.badge, type: message.clanType, minLevel: message.minLevel })),
            };
          case "view":
            return { action: "view", ok: true, ...(await clans.view(userId, message.tag)) };
          case "ranking":
            return { action: "ranking", ok: true, ...(await clans.ranking(userId)) };
          case "request_donation":
            return { action: "request_donation", ok: true, ...(await clans.requestDonation(userId, message.itemId, message.amount)) };
          case "donate":
            return { action: "donate", ok: true, ...(await clans.donate(userId, message.code)) };
        }
      },
    });
  }
}
