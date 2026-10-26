import crypto from "node:crypto";

import { AppError } from "../../shared/errors/app-error.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { createLogger } from "../../shared/logger.js";
import { deviceKeyOf, guestNickname, randomToken, type PasswordHasher, type TokenHasher } from "../../shared/security/password-hasher.js";
import type { SessionStore } from "../../shared/security/session-store.js";
import type { AccessTokenService } from "../../shared/security/token-service.js";
import type { WalletLedger } from "../economy/wallet-ledger.js";
import { toProfileDto } from "../profile/profile.mapper.js";
import type { ProfileRepository } from "../profile/profile.repository.js";
import type { AuthOutcome, AuthResultDto } from "./auth.dto.js";
import { toAccountDto } from "./auth.mapper.js";
import type { AccountRow, AuthRepository } from "./auth.ports.js";
import { committedFailure, PasswordGuard, runCommitted } from "./password-guard.js";

/** Extra attempts when two first launches of the same device race on the device binding (unique index). */
const DEVICE_BIND_RETRIES = 2;

const logger = createLogger("AuthService");

export type AuthServiceOptions = {
  refreshTtlDays: number;
};

/** Request metadata recorded with tokens and audit rows. */
export type DeviceInfo = { deviceId: string; platform?: string | null; ip?: string | null; userAgent?: string | null };

type IssuedCredentials = AuthResultDto & { accessJti: string; deviceKey: string; created: boolean };

/**
 * Sign-in use cases. There is no login screen: every device owns one guest account (`deviceLogin`), created on the
 * first launch and found again on the next ones. A player who links an email (`account/link_email`) loses the device
 * binding and signs in with the refresh token or with email + password (`login`) from then on.
 */
export class AuthService {
  private readonly guard: PasswordGuard;

  constructor(
    private readonly users: AuthRepository,
    private readonly profiles: ProfileRepository,
    private readonly wallets: WalletLedger,
    private readonly sessions: SessionStore,
    private readonly tokens: AccessTokenService,
    private readonly passwords: PasswordHasher,
    private readonly refreshHasher: TokenHasher,
    private readonly deviceHasher: TokenHasher,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly options: AuthServiceOptions,
  ) {
    this.guard = new PasswordGuard(users, passwords, clock);
  }

  /** Device key used for sessions and refresh tokens (peppered hash prefix of the raw device id). */
  deviceKey(deviceId: string): string {
    return deviceKeyOf(this.deviceHasher.hash(deviceId));
  }

  /** Signs the device into its guest account, creating it (with its profile and wallet) on the first call. */
  async deviceLogin(device: DeviceInfo): Promise<AuthOutcome> {
    const deviceHash = this.deviceHasher.hash(device.deviceId);
    const deviceKey = deviceKeyOf(deviceHash);
    const platform = device.platform || null;

    for (let attempt = 0; ; attempt++) {
      try {
        const issued = await this.uow.transaction(async (session) => {
          let userId: string | null = null;
          let created = false;

          const boundUserId = await this.users.findDeviceBinding(deviceHash, session, true);
          if (boundUserId) {
            const account = await this.users.getAccountById(boundUserId, session, true);
            if (account?.isGuest) {
              await this.checkBan(account, session);
              await this.users.touchDevice(deviceHash, platform, session);
              userId = account.id;
            } else {
              // Stale binding (the account linked an email or is gone): the device starts a fresh guest.
              await this.users.deleteDeviceBinding(deviceHash, session);
            }
          }

          if (!userId) {
            userId = crypto.randomUUID();
            created = true;
            await this.users.insertGuest(userId, session);
            await this.users.bindDevice(userId, deviceHash, platform, session);
            await this.profiles.ensureProfile(userId, guestNickname(), session);
            await this.wallets.open(session, userId);
          }

          await this.users.markLogin(userId, session);
          const credentials = await this.issueCredentials(userId, deviceKey, device, session, created);
          await this.users.audit(userId, created ? "GUEST_CREATED" : "DEVICE_LOGIN", { platform, ip: device.ip ?? null }, session);
          return credentials;
        });
        return this.complete(issued);
      } catch (error) {
        // Two first launches of the same device raced: the loser retries and finds the winner's binding.
        if (!isDuplicateKeyError(error) || attempt >= DEVICE_BIND_RETRIES) throw error;
      }
    }
  }

  /** Email + password sign-in on this device (accounts that linked an email). The device's guest binding is kept. */
  async login(email: string, password: string, device: DeviceInfo): Promise<AuthOutcome> {
    const deviceKey = this.deviceKey(device.deviceId);

    const issued = await runCommitted(this.uow, async (session) => {
      const account = await this.users.findByEmail(email, session, true);
      if (!account) {
        await this.guard.dummyVerify(password);
        return committedFailure(ErrorCode.AUTH_INVALID_CREDENTIALS);
      }
      await this.checkBan(account, session);
      if (!(await this.guard.verify(account, password, session))) return committedFailure(ErrorCode.AUTH_INVALID_CREDENTIALS);

      await this.users.markLogin(account.id, session);
      await this.profiles.ensureProfile(account.id, guestNickname(), session);
      const credentials = await this.issueCredentials(account.id, deviceKey, device, session, false);
      await this.users.audit(account.id, "LOGIN", { ip: device.ip ?? null }, session);
      return credentials;
    });

    return this.complete(issued);
  }

  /**
   * Rotates the refresh token and issues a new access token. The new access token keeps the device's current session
   * id, so rooms the client already joined stay valid while new joins get a fresh, unexpired token.
   */
  async refresh(userId: string, refreshToken: string, device: DeviceInfo): Promise<AuthOutcome> {
    const deviceKey = this.deviceKey(device.deviceId);
    const tokenHash = this.refreshHasher.hash(refreshToken);
    const keepJti = await this.currentAccessJti(userId, deviceKey);

    const issued = await this.uow.transaction(async (session) => {
      const row = await this.users.findRefreshToken(userId, deviceKey, tokenHash, session);
      if (!row || row.isRevoked) throw new AppError(ErrorCode.AUTH_INVALID_REFRESH);
      if (row.isBanned && this.isBanActive(row.banExpiresAt)) throw this.bannedError(row.banReason, row.banExpiresAt);

      await this.users.markLogin(userId, session);
      const credentials = await this.issueCredentials(userId, deviceKey, device, session, false, keepJti);
      await this.users.audit(userId, "REFRESH", { ip: device.ip ?? null }, session);
      return credentials;
    });

    return this.complete(issued);
  }

  /**
   * Ends the device's session. The caller proves it owns the device with its refresh token; a logout whose token does
   * not match revokes nothing (same answer either way).
   */
  async logout(userId: string, refreshToken: string, deviceId: string): Promise<void> {
    const deviceKey = this.deviceKey(deviceId);
    const matched = await this.uow.transaction(async (session) => {
      const revoked = await this.users.revokeRefreshToken(userId, deviceKey, this.refreshHasher.hash(refreshToken), session);
      if (revoked) await this.users.audit(userId, "LOGOUT", null, session);
      return revoked;
    });
    if (matched) await this.sessions.deleteSession(userId, deviceKey);
  }

  async banUser(userId: string, reason: string | null, until: Date | null): Promise<void> {
    await this.uow.transaction(async (session) => {
      await this.users.setBan(userId, true, reason, until, session);
      await this.users.audit(userId, "BAN", { reason, until: until?.toISOString() ?? null }, session);
    });
    await this.sessions.deleteAllSessions(userId);
  }

  // ------------------------------------------------------------------ internals
  /** Active ban: throws AUTH_BANNED. Expired ban: lifted. */
  private async checkBan(account: AccountRow, session: DbSession): Promise<void> {
    if (!account.isBanned) return;
    if (this.isBanActive(account.banExpiresAt)) throw this.bannedError(account.banReason, account.banExpiresAt);
    await this.users.setBan(account.id, false, null, null, session);
  }

  private bannedError(reason: string | null, until: Date | null): AppError {
    return new AppError(ErrorCode.AUTH_BANNED, { extra: { reason: reason ?? null, until: until ? Math.floor(until.getTime() / 1000) : null } });
  }

  private isBanActive(until: Date | null): boolean {
    return !until || until.getTime() > this.clock.nowMs();
  }

  private async issueCredentials(
    userId: string,
    deviceKey: string,
    device: DeviceInfo,
    session: DbSession,
    created: boolean,
    keepJti?: string,
  ): Promise<IssuedCredentials> {
    const access = this.tokens.sign(userId, deviceKey, keepJti);
    const refreshToken = randomToken();
    await this.users.saveRefreshToken({
      userId,
      deviceKey,
      tokenHash: this.refreshHasher.hash(refreshToken),
      expiresAt: new Date(this.clock.nowMs() + this.options.refreshTtlDays * 86_400_000),
      ip: device.ip ?? null,
      userAgent: device.userAgent ?? null,
    }, session);

    return {
      userId,
      accessToken: access.token,
      accessExpiresAtUnix: Math.floor(access.expiresAt.getTime() / 1000),
      refreshToken,
      accessJti: access.accessJti,
      deviceKey,
      created,
    };
  }

  /** After the commit: stores the session (a newer token on the same device invalidates older ones) and builds the reply. */
  private async complete(issued: IssuedCredentials): Promise<AuthOutcome> {
    const { accessJti, deviceKey, created, ...result } = issued;
    await this.sessions.setSession(result.userId, deviceKey, { accessJti });

    const account = await this.users.getAccountById(result.userId);
    const profile = await this.profiles.getProfile(result.userId);
    if (!account || !profile) throw new AppError(ErrorCode.UNAUTHORIZED);
    const wallet = await this.wallets.snapshot(result.userId);
    return {
      ...result,
      account: toAccountDto(account),
      profile: toProfileDto(profile),
      wallet,
      created,
      serverTimeUnix: this.clock.nowUnix(),
    };
  }

  /** Session id currently stored for the device (undefined when there is none or the store is unreachable). */
  private async currentAccessJti(userId: string, deviceKey: string): Promise<string | undefined> {
    try {
      return (await this.sessions.getSession(userId, deviceKey))?.accessJti || undefined;
    } catch (error) {
      logger.warn("session read failed:", (error as Error).message);
      return undefined;
    }
  }
}
