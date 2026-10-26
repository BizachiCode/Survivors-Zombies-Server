import { and, eq, gt, ne, sql } from "drizzle-orm";

import { DrizzleRepository, affectedRows } from "../../infrastructure/database/drizzle-unit-of-work.js";
import { auditEvents, userDevices, userRefreshTokens, users } from "../../infrastructure/database/schema/index.js";
import type { DbSession } from "../../shared/kernel/unit-of-work.js";
import type { AccountRow, AuditKind, AuthRepository, RefreshLookupRow, RefreshTokenRecord } from "./auth.ports.js";

const accountColumns = {
  id: users.id,
  email: users.email,
  passwordHash: users.passwordHash,
  isGuest: users.isGuest,
  failedLogins: users.failedLogins,
  lockedUntil: users.lockedUntil,
  isBanned: users.isBanned,
  banReason: users.banReason,
  banExpiresAt: users.banExpiresAt,
  createdAt: users.createdAt,
};

export class DrizzleAuthRepository extends DrizzleRepository implements AuthRepository {
  async findDeviceBinding(deviceHash: string, session?: DbSession, forUpdate = false): Promise<string | null> {
    const query = this.db(session).select({ userId: userDevices.userId }).from(userDevices).where(eq(userDevices.deviceHash, deviceHash)).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0]?.userId ?? null;
  }

  async bindDevice(userId: string, deviceHash: string, platform: string | null, session: DbSession): Promise<void> {
    await this.db(session).insert(userDevices).values({ userId, deviceHash, platform });
  }

  async touchDevice(deviceHash: string, platform: string | null, session: DbSession): Promise<void> {
    await this.db(session).update(userDevices)
      .set({ lastSeenAt: sql`CURRENT_TIMESTAMP`, ...(platform ? { platform } : {}) })
      .where(eq(userDevices.deviceHash, deviceHash));
  }

  async deleteDeviceBinding(deviceHash: string, session: DbSession): Promise<void> {
    await this.db(session).delete(userDevices).where(eq(userDevices.deviceHash, deviceHash));
  }

  async deleteDeviceBindingsOf(userId: string, session: DbSession): Promise<number> {
    return affectedRows(await this.db(session).delete(userDevices).where(eq(userDevices.userId, userId)));
  }

  async insertGuest(userId: string, session: DbSession): Promise<void> {
    await this.db(session).insert(users).values({ id: userId, isGuest: true });
  }

  async getAccountById(userId: string, session?: DbSession, forUpdate = false): Promise<AccountRow | null> {
    const query = this.db(session).select(accountColumns).from(users).where(eq(users.id, userId)).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ?? null;
  }

  async findByEmail(email: string, session?: DbSession, forUpdate = false): Promise<AccountRow | null> {
    const query = this.db(session).select(accountColumns).from(users).where(eq(users.email, email)).limit(1);
    const rows = forUpdate ? await query.for("update") : await query;
    return rows[0] ?? null;
  }

  async emailExists(email: string, session?: DbSession): Promise<boolean> {
    const rows = await this.db(session).select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    return rows.length > 0;
  }

  async setCredentials(userId: string, email: string, passwordHash: string, changedAt: Date, session: DbSession): Promise<void> {
    await this.db(session).update(users)
      .set({ email, passwordHash, isGuest: false, passwordChangedAt: changedAt, failedLogins: 0, lockedUntil: null })
      .where(eq(users.id, userId));
  }

  async updatePasswordHash(userId: string, passwordHash: string, changedAt: Date, session: DbSession): Promise<void> {
    await this.db(session).update(users).set({ passwordHash, passwordChangedAt: changedAt }).where(eq(users.id, userId));
  }

  async setFailedLogins(userId: string, failedLogins: number, lockedUntil: Date | null, session?: DbSession): Promise<void> {
    await this.db(session).update(users).set({ failedLogins, lockedUntil }).where(eq(users.id, userId));
  }

  async markLogin(userId: string, session?: DbSession): Promise<void> {
    await this.db(session).update(users)
      .set({ lastLoginAt: sql`CURRENT_TIMESTAMP`, failedLogins: 0, lockedUntil: null })
      .where(eq(users.id, userId));
  }

  async setBan(userId: string, banned: boolean, reason: string | null, until: Date | null, session?: DbSession): Promise<void> {
    await this.db(session).update(users)
      .set({ isBanned: banned, banReason: banned ? reason : null, banExpiresAt: banned ? until : null })
      .where(eq(users.id, userId));
  }

  async saveRefreshToken(record: RefreshTokenRecord, session: DbSession): Promise<void> {
    await this.db(session).insert(userRefreshTokens).values({
      userId: record.userId,
      deviceKey: record.deviceKey,
      tokenHash: record.tokenHash,
      expiresAt: record.expiresAt,
      ip: record.ip ?? null,
      userAgent: record.userAgent ?? null,
    }).onDuplicateKeyUpdate({
      set: {
        tokenHash: record.tokenHash,
        expiresAt: record.expiresAt,
        isRevoked: false,
        issuedAt: sql`CURRENT_TIMESTAMP`,
        lastUsedAt: sql`CURRENT_TIMESTAMP`,
        ip: record.ip ?? null,
        userAgent: record.userAgent ?? null,
      },
    });
  }

  async findRefreshToken(userId: string, deviceKey: string, tokenHash: string, session?: DbSession): Promise<RefreshLookupRow | null> {
    const query = this.db(session)
      .select({
        isRevoked: userRefreshTokens.isRevoked,
        isBanned: users.isBanned,
        banReason: users.banReason,
        banExpiresAt: users.banExpiresAt,
      })
      .from(userRefreshTokens)
      .innerJoin(users, eq(users.id, userRefreshTokens.userId))
      .where(and(
        eq(userRefreshTokens.userId, userId),
        eq(userRefreshTokens.deviceKey, deviceKey),
        eq(userRefreshTokens.tokenHash, tokenHash),
        gt(userRefreshTokens.expiresAt, sql`CURRENT_TIMESTAMP`),
      ))
      .limit(1);
    const rows = session ? await query.for("update") : await query;
    return rows[0] ?? null;
  }

  async revokeRefreshToken(userId: string, deviceKey: string, tokenHash: string, session?: DbSession): Promise<boolean> {
    const result = await this.db(session).update(userRefreshTokens)
      .set({ isRevoked: true })
      .where(and(eq(userRefreshTokens.userId, userId), eq(userRefreshTokens.deviceKey, deviceKey), eq(userRefreshTokens.tokenHash, tokenHash)));
    return affectedRows(result) > 0;
  }

  async revokeRefreshTokensExcept(userId: string, keepDeviceKey: string, session: DbSession): Promise<string[]> {
    const rows = await this.db(session).select({ deviceKey: userRefreshTokens.deviceKey }).from(userRefreshTokens)
      .where(and(eq(userRefreshTokens.userId, userId), ne(userRefreshTokens.deviceKey, keepDeviceKey), eq(userRefreshTokens.isRevoked, false)))
      .for("update");
    if (rows.length === 0) return [];
    await this.db(session).update(userRefreshTokens).set({ isRevoked: true })
      .where(and(eq(userRefreshTokens.userId, userId), ne(userRefreshTokens.deviceKey, keepDeviceKey)));
    return rows.map((row) => row.deviceKey);
  }

  async audit(userId: string | null, kind: AuditKind, meta: Record<string, unknown> | null, session?: DbSession): Promise<void> {
    await this.db(session).insert(auditEvents).values({ userId, kind, meta });
  }
}
