// Room `profile`: HUD snapshot (profile + wallet), nickname and avatar. One request type (`profile`) multiplexed by `type`.

import { Schema } from "@colyseus/schema";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { ProfileService } from "./profile.service.js";
import { PROFILE_ACTIONS, ProfileMessageSchema, type ProfileMessage } from "./profile.validation.js";

export class ProfileState extends Schema {}

export type ProfileRoomDeps = {
  profiles: ProfileService;
  /** Per-user limiter for `info`. */
  queryLimiter: RateLimiter;
  /** Per-user limiter for nickname / avatar changes. */
  changeLimiter: RateLimiter;
};

function actionOf(raw: unknown): string {
  const type = (raw as { type?: unknown } | null)?.type;
  return typeof type === "string" && PROFILE_ACTIONS.has(type) ? type : "unknown";
}

export class ProfileRoom extends AuthenticatedRoom<ProfileState, ProfileRoomDeps> {
  state = new ProfileState();

  onCreate(): void {
    this.handleAuthenticatedRequest<ProfileMessage>("profile", {
      schema: ProfileMessageSchema,
      formatError: (failure, raw) => ({
        action: actionOf(raw),
        ok: false,
        error: failure.error,
        ...(failure.extra ? { extra: failure.extra } : {}),
      }),
      handle: async ({ userId }, message) => {
        const limiter = message.type === "info" ? this.deps.queryLimiter : this.deps.changeLimiter;
        if (!(await limiter.allow(userId))) throw new AppError(ErrorCode.RATE_LIMIT);
        const profiles = this.deps.profiles;

        switch (message.type) {
          case "info":
            return { action: "info", ok: true, ...(await profiles.info(userId)) };
          case "set_nickname":
            return { action: "set_nickname", ok: true, profile: await profiles.setNickname(userId, message.nickname) };
          case "set_avatar":
            return { action: "set_avatar", ok: true, profile: await profiles.setAvatar(userId, message.avatarId) };
        }
      },
    });
  }
}
