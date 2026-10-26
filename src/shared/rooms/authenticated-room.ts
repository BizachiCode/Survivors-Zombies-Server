import { ServerError, type AuthContext, type Client } from "@colyseus/core";
import { Schema } from "@colyseus/schema";

import { AppError } from "../errors/app-error.js";
import { ErrorCode } from "../errors/error-codes.js";
import type { AccessAuthenticator, AuthenticatedIdentity } from "../security/access-authenticator.js";
import type { RateLimiter } from "../security/rate-limiter.js";
import { BaseRoom } from "./base-room.js";
import { clientAddress, forwardedAddressOf } from "./client-address.js";
import { executeRequest, type RequestSpec } from "./request-handler.js";

/** `client.auth` of authenticated rooms. */
export type RoomIdentity = AuthenticatedIdentity & {
  address: string | null;
};

/** Context passed to request handlers of authenticated rooms. */
export type RequestContext = {
  client: Client;
  identity: RoomIdentity;
  userId: string;
};

/** Re-validate the session at most this often per client (ms). */
const SESSION_RECHECK_MS = 5_000;

let authenticator: AccessAuthenticator | null = null;
let ipLimiter: RateLimiter | null = null;
let joinLimiter: RateLimiter | null = null;

/** Wires the authenticator (and the per-IP / per-account join limiters) used by every {@link AuthenticatedRoom}. */
export function configureRoomAuthentication(value: AccessAuthenticator, options: { ipLimiter?: RateLimiter; joinLimiter?: RateLimiter } = {}): void {
  authenticator = value;
  ipLimiter = options.ipLimiter ?? null;
  joinLimiter = options.joinLimiter ?? null;
}

function requireAuthenticator(): AccessAuthenticator {
  if (!authenticator) throw new Error("Room authentication is not configured (configureRoomAuthentication).");
  return authenticator;
}

/** Access token sent by the client as the join option `accessToken` (issued by the `auth` room). */
export function readAccessToken(options: any): string {
  return typeof options?.accessToken === "string" ? options.accessToken : "";
}

/**
 * Base class for rooms that require a signed-in player.
 * - Authenticates at matchmaking time (static onAuth): invalid tokens can't even create rooms.
 * - Re-validates the session on requests, so revoked sessions stop working within seconds.
 */
export abstract class AuthenticatedRoom<TState extends Schema = Schema, TDeps = unknown> extends BaseRoom<TState, TDeps> {
  static async onAuth(_token: string, options: any, context: AuthContext): Promise<RoomIdentity | false> {
    const identity = await requireAuthenticator().authenticate(readAccessToken(options));
    if (!identity) return false;
    // Seat reservations per account: rooms are created before anybody connects, so a script could spawn them in a loop.
    if (joinLimiter && !(await joinLimiter.allow(identity.userId))) throw new ServerError(429, "RATE_LIMIT");
    return { ...identity, address: forwardedAddressOf(context) };
  }

  /** Registers an authenticated request handler (rate-limit key = user id). */
  protected handleAuthenticatedRequest<TPayload>(type: string, spec: RequestSpec<TPayload, RequestContext>): void {
    this.onMessage(type, (client, rawPayload, messageContext) =>
      executeRequest<TPayload, RequestContext>({
        type,
        rawPayload,
        messageContext,
        spec,
        logger: this.logger,
        rateLimitKey: (client.auth as RoomIdentity | undefined)?.userId ?? null,
        resolveContext: () => this.resolveRequestContext(client),
      }),
    );
  }

  /** Returns the identity of an authenticated client, re-checking the session periodically. */
  protected async resolveRequestContext(client: Client): Promise<RequestContext> {
    const identity = client.auth as RoomIdentity | undefined;
    if (!identity?.userId) throw new AppError(ErrorCode.UNAUTHORIZED);
    const address = clientAddress(client);
    if (ipLimiter && address && !(await ipLimiter.allow(address))) throw new AppError(ErrorCode.RATE_LIMIT);

    const userData = (client.userData ??= {}) as { sessionCheckedAt?: number };
    const now = Date.now();
    if (!userData.sessionCheckedAt || now - userData.sessionCheckedAt > SESSION_RECHECK_MS) {
      if (!(await requireAuthenticator().isSessionActive(identity))) throw new AppError(ErrorCode.UNAUTHORIZED);
      userData.sessionCheckedAt = now;
    }
    return { client, identity, userId: identity.userId };
  }
}
