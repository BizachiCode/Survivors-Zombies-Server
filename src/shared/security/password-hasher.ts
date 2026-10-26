// Password, refresh-token and device-id hashing.
// Passwords: Argon2id + server pepper. Refresh tokens and device ids: keyed SHA-256 (fast, high-entropy inputs).

import crypto from "node:crypto";
import argon2 from "argon2";

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, passwordHash: string): Promise<boolean>;
}

export interface TokenHasher {
  /** 64 hex characters. */
  hash(value: string): string;
}

export class Argon2PasswordHasher implements PasswordHasher {
  constructor(private readonly pepper: string) {}

  hash(plain: string): Promise<string> {
    return argon2.hash(plain + this.pepper, { type: argon2.argon2id, timeCost: 3, memoryCost: 19456, parallelism: 1 });
  }

  async verify(plain: string, passwordHash: string): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, plain + this.pepper);
    } catch {
      return false;
    }
  }
}

/** HMAC-SHA-256 with a server pepper: the database never holds a usable token or a raw device id. */
export class HmacTokenHasher implements TokenHasher {
  constructor(private readonly pepper: string) {}

  hash(value: string): string {
    return crypto.createHmac("sha256", this.pepper).update(value, "utf8").digest("hex");
  }
}

/**
 * Device key used in sessions, refresh tokens and access tokens: a shortened keyed hash of the device id, so the raw
 * id (which binds the guest account) never leaves the auth service.
 */
export function deviceKeyOf(deviceHash: string): string {
  return deviceHash.slice(0, 32);
}

/** URL-safe random token (refresh tokens). */
export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Default display name for new guests ("Player-12345"); the player renames it in the profile. */
export function guestNickname(): string {
  return `Player-${crypto.randomInt(0, 100000).toString().padStart(5, "0")}`;
}
