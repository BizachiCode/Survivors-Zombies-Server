// Anonymous room used to obtain credentials. One request type (`auth`) multiplexed by `type`.

import type { AuthContext } from "@colyseus/core";
import { Schema } from "@colyseus/schema";

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import { BaseRoom } from "../../shared/rooms/base-room.js";
import { clientAddress, forwardedAddressOf } from "../../shared/rooms/client-address.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { AuthService } from "./auth.service.js";
import { AUTH_ACTIONS, AuthMessageSchema, type AuthMessage } from "./auth.validation.js";

export class AuthState extends Schema {}

export type AuthRoomDeps = {
  auth: AuthService;
  /** Per-IP limiter for credential attempts. */
  limiter: RateLimiter;
  isMaintenanceEnabled: () => boolean;
};

function actionOf(raw: unknown): string {
  const type = (raw as { type?: unknown } | null)?.type;
  return typeof type === "string" && AUTH_ACTIONS.has(type) ? type : "unknown";
}

export class AuthRoom extends BaseRoom<AuthState, AuthRoomDeps> {
  state = new AuthState();

  /** Anonymous room: only records the forwarded address (TRUST_PROXY), see shared/rooms/client-address.ts. */
  static async onAuth(_token: string, _options: unknown, context: AuthContext) {
    return { address: forwardedAddressOf(context) };
  }

  onCreate(): void {
    this.handleRequest<AuthMessage>("auth", {
      schema: AuthMessageSchema,
      invalidPayloadError: ErrorCode.AUTH_INVALID_PAYLOAD,
      rateLimit: this.deps.limiter,
      rateLimitError: ErrorCode.AUTH_RATE_LIMIT,
      formatError: (failure, raw) => {
        const action = actionOf(raw);
        const error = action === "unknown" && failure.error === ErrorCode.AUTH_INVALID_PAYLOAD ? ErrorCode.AUTH_UNKNOWN_ACTION : failure.error;
        return { action, ok: false, error, ...(failure.extra ? { extra: failure.extra } : {}) };
      },
      handle: async ({ client }, message) => {
        if (this.deps.isMaintenanceEnabled() && message.type !== "logout") throw new AppError(ErrorCode.MAINTENANCE);

        const ip = clientAddress(client);
        const userAgent = "userAgent" in message ? message.userAgent : undefined;
        const platform = "platform" in message ? message.platform : undefined;
        const device = { deviceId: message.deviceId, platform, ip, userAgent };

        switch (message.type) {
          case "device":
            return { action: "device", ok: true, ...(await this.deps.auth.deviceLogin(device)) };
          case "login":
            return { action: "login", ok: true, ...(await this.deps.auth.login(message.email, message.password, device)) };
          case "refresh":
            return { action: "refresh", ok: true, ...(await this.deps.auth.refresh(message.userId, message.refreshToken, device)) };
          case "logout":
            await this.deps.auth.logout(message.userId, message.refreshToken, message.deviceId);
            return { action: "logout", ok: true };
        }
      },
    });
  }
}
