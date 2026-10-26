import type { DbSession } from "../../shared/kernel/unit-of-work.js";

/** Account row (credentials, guest flag, lock and ban state). */
export type AccountRow = {
  id: string;
  email: string | null;
  passwordHash: string | null;
  isGuest: boolean;
  failedLogins: number;
  lockedUntil: Date | null;
  isBanned: boolean;
  banReason: string | null;
  banExpiresAt: Date | null;
  createdAt: Date;
};

export type RefreshTokenRecord = {
  userId: string;
  deviceKey: string;
  tokenHash: string;
  expiresAt: Date;
  ip?: string | null;
  userAgent?: string | null;
};

export type RefreshLookupRow = {
  isRevoked: boolean;
  isBanned: boolean;
  banReason: string | null;
  banExpiresAt: Date | null;
};

export type AuditKind =
  | "GUEST_CREATED"
  | "DEVICE_LOGIN"
  | "LOGIN"
  | "REFRESH"
  | "LOGOUT"
  | "LINK_EMAIL"
  | "PASSWORD_CHANGE"
  | "NICKNAME_CHANGE"
  | "BAN"
  | "UNBAN";

/** Persistence port for accounts, guest device bindings, refresh tokens and the audit trail. */
export interface AuthRepository {
  /** Account id bound to the device hash (`forUpdate` locks the binding row). */
  findDeviceBinding(deviceHash: string, session?: DbSession, forUpdate?: boolean): Promise<string | null>;
  /** Binds a device to a (guest) account. Throws a duplicate-key error when the device is already bound. */
  bindDevice(userId: string, deviceHash: string, platform: string | null, session: DbSession): Promise<void>;
  touchDevice(deviceHash: string, platform: string | null, session: DbSession): Promise<void>;
  deleteDeviceBinding(deviceHash: string, session: DbSession): Promise<void>;
  /** Removes every device binding of the account (email linked: the device alone no longer opens it). */
  deleteDeviceBindingsOf(userId: string, session: DbSession): Promise<number>;

  insertGuest(userId: string, session: DbSession): Promise<void>;
  getAccountById(userId: string, session?: DbSession, forUpdate?: boolean): Promise<AccountRow | null>;
  findByEmail(email: string, session?: DbSession, forUpdate?: boolean): Promise<AccountRow | null>;
  emailExists(email: string, session?: DbSession): Promise<boolean>;
  /** Guest → registered: sets email + password hash, clears the guest flag, stamps password_changed_at. */
  setCredentials(userId: string, email: string, passwordHash: string, changedAt: Date, session: DbSession): Promise<void>;
  updatePasswordHash(userId: string, passwordHash: string, changedAt: Date, session: DbSession): Promise<void>;
  setFailedLogins(userId: string, failedLogins: number, lockedUntil: Date | null, session?: DbSession): Promise<void>;
  markLogin(userId: string, session?: DbSession): Promise<void>;
  setBan(userId: string, banned: boolean, reason: string | null, until: Date | null, session?: DbSession): Promise<void>;

  /** Upserts the device's refresh token (one per user + device). */
  saveRefreshToken(record: RefreshTokenRecord, session: DbSession): Promise<void>;
  /** Unexpired token row matching (user, device, hash), revoked or not; locked when a session is given. */
  findRefreshToken(userId: string, deviceKey: string, tokenHash: string, session?: DbSession): Promise<RefreshLookupRow | null>;
  /** Revokes the (user, device, hash) token; false when no such token exists. */
  revokeRefreshToken(userId: string, deviceKey: string, tokenHash: string, session?: DbSession): Promise<boolean>;
  /** Revokes every active refresh token of the user except `keepDeviceKey`; returns the device keys. */
  revokeRefreshTokensExcept(userId: string, keepDeviceKey: string, session: DbSession): Promise<string[]>;

  audit(userId: string | null, kind: AuditKind, meta: Record<string, unknown> | null, session?: DbSession): Promise<void>;
}
