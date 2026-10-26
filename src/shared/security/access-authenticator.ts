import type { AccessTokenService } from "./token-service.js";
import type { SessionStore } from "./session-store.js";

/** Identity attached to an authenticated room client (`client.auth`). */
export type AuthenticatedIdentity = {
  userId: string;
  deviceKey: string;
  accessJti: string;
};

/**
 * Validates access tokens against the JWT signature AND the active session store, so a logout, a ban or a newer
 * sign-in on the same device immediately invalidates older tokens.
 */
export class AccessAuthenticator {
  constructor(
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionStore,
  ) {}

  async authenticate(token?: string | null): Promise<AuthenticatedIdentity | null> {
    if (!token) return null;
    const payload = this.tokens.verify(token);
    if (!payload) return null;
    const identity: AuthenticatedIdentity = { userId: payload.sub, deviceKey: payload.device, accessJti: payload.jti };
    return (await this.isSessionActive(identity)) ? identity : null;
  }

  /** True while the identity's session still exists and was issued for this exact token. */
  async isSessionActive(identity: AuthenticatedIdentity): Promise<boolean> {
    const session = await this.sessions.getSession(identity.userId, identity.deviceKey);
    if (!session || session.accessJti !== identity.accessJti) return false;
    await this.sessions.touchSession(identity.userId, identity.deviceKey);
    return true;
  }
}
