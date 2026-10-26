// Room `collection`: the player's cards, items and team (the collection / Almanac screen). One request type
// (`collection`) multiplexed by `type`.

import { Schema } from "@colyseus/schema";
import { z } from "zod";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import { id, strictPayload } from "../../shared/validation.js";
import type { CollectionService } from "./collection.service.js";

export const CollectionMessageSchema = z.discriminatedUnion("type", [
  strictPayload({ type: z.literal("info") }),
  strictPayload({ type: z.literal("unlock"), cardId: id(64), method: z.enum(["seeds", "purchase"]) }),
  strictPayload({ type: z.literal("upgrade"), cardId: id(64) }),
  strictPayload({ type: z.literal("set_deck"), cards: z.array(id(64)).min(1).max(12) }),
]);

export type CollectionMessage = z.infer<typeof CollectionMessageSchema>;

const ACTIONS = new Set(["info", "unlock", "upgrade", "set_deck"]);

export class CollectionState extends Schema {}

export type CollectionRoomDeps = {
  collection: CollectionService;
  /** Per-user limiter for `info`. */
  queryLimiter: RateLimiter;
  /** Per-user limiter for unlocks, upgrades and team changes. */
  changeLimiter: RateLimiter;
};

export class CollectionRoom extends AuthenticatedRoom<CollectionState, CollectionRoomDeps> {
  state = new CollectionState();

  onCreate(): void {
    this.handleAuthenticatedRequest<CollectionMessage>("collection", {
      schema: CollectionMessageSchema,
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
        const collection = this.deps.collection;
        switch (message.type) {
          case "info":
            return { action: "info", ok: true, ...(await collection.info(userId)) };
          case "unlock":
            return { action: "unlock", ok: true, ...(await collection.unlock(userId, message.cardId, message.method)) };
          case "upgrade":
            return { action: "upgrade", ok: true, ...(await collection.upgrade(userId, message.cardId)) };
          case "set_deck":
            return { action: "set_deck", ok: true, ...(await collection.setDeck(userId, message.cards)) };
        }
      },
    });
  }
}
