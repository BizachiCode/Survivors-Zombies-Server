// JWT access tokens (short lived). Refresh tokens are opaque random strings hashed in the database.

import crypto from "node:crypto";
import jwt from "jsonwebtoken";

export type AccessPayload = {
  sub: string;
  /** Hashed device key (see DeviceKeyHasher), never the raw device id. */
  device: string;
  jti: string;
  iat?: number;
  exp?: number;
};

export type SignedAccessToken = {
  token: string;
  expiresAt: Date;
  accessJti: string;
};

export interface AccessTokenService {
  /** `accessJti` keeps an existing session id (silent refresh); a new one is generated when omitted. */
  sign(userId: string, deviceKey: string, accessJti?: string): SignedAccessToken;
  verify(token: string): AccessPayload | null;
}

/** Fixed JWT settings: HS256 only, issuer + audience pinned (no `alg: none`, no key confusion). */
export const JWT_ALGORITHM = "HS256" as const;
export const JWT_ISSUER = "card-tower-defense";
export const JWT_AUDIENCE = "card-tower-defense-client";

export class JwtAccessTokenService implements AccessTokenService {
  constructor(
    private readonly secret: string,
    private readonly ttlMinutes: number,
  ) {}

  sign(userId: string, deviceKey: string, jti?: string): SignedAccessToken {
    const accessJti = jti || crypto.randomBytes(16).toString("base64url");
    const expSec = Math.floor(Date.now() / 1000) + this.ttlMinutes * 60;
    const token = jwt.sign({ sub: userId, device: deviceKey }, this.secret, {
      algorithm: JWT_ALGORITHM,
      expiresIn: `${this.ttlMinutes}m`,
      jwtid: accessJti,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    return { token, expiresAt: new Date(expSec * 1000), accessJti };
  }

  verify(token: string): AccessPayload | null {
    try {
      const payload = jwt.verify(token, this.secret, {
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      }) as Partial<AccessPayload>;
      if (!payload?.sub || !payload?.device || !payload?.jti) return null;
      // Every token this server signs expires; one without `exp` (only forgeable with the secret) is never accepted.
      if (typeof payload.exp !== "number") return null;
      return { sub: String(payload.sub), device: String(payload.device), jti: String(payload.jti), iat: payload.iat, exp: payload.exp };
    } catch {
      return null;
    }
  }
}
