// Account management for signed-in players: info, guest → email upgrade, password change.

import { AppError } from "../../shared/errors/app-error.js";
import { isDuplicateKeyError } from "../../shared/errors/db-errors.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { createLogger } from "../../shared/logger.js";
import type { PasswordHasher } from "../../shared/security/password-hasher.js";
import type { SessionStore } from "../../shared/security/session-store.js";
import type { AccountDto } from "../auth/auth.dto.js";
import { toAccountDto } from "../auth/auth.mapper.js";
import type { AuthRepository } from "../auth/auth.ports.js";
import { committedFailure, PasswordGuard, runCommitted } from "../auth/password-guard.js";

const logger = createLogger("AccountService");

export class AccountService {
  private readonly guard: PasswordGuard;

  constructor(
    private readonly users: AuthRepository,
    private readonly passwords: PasswordHasher,
    private readonly sessions: SessionStore,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {
    this.guard = new PasswordGuard(users, passwords, clock);
  }

  async info(userId: string): Promise<AccountDto> {
    const account = await this.users.getAccountById(userId);
    if (!account) throw new AppError(ErrorCode.UNAUTHORIZED);
    return toAccountDto(account);
  }

  /**
   * Guest → registered: sets email + password and removes the device bindings, so from now on the account opens with
   * its refresh token or with email + password, never with a device id alone. The current session stays valid.
   */
  async linkEmail(userId: string, email: string, password: string): Promise<AccountDto> {
    // Cheap pre-check so registered accounts don't pay for an Argon2 hash; re-checked under lock below.
    const current = await this.users.getAccountById(userId);
    if (!current) throw new AppError(ErrorCode.UNAUTHORIZED);
    if (!current.isGuest) throw new AppError(ErrorCode.ACCOUNT_NOT_GUEST);

    const passwordHash = await this.passwords.hash(password);
    try {
      await this.uow.transaction(async (session) => {
        const account = await this.users.getAccountById(userId, session, true);
        if (!account) throw new AppError(ErrorCode.UNAUTHORIZED);
        if (!account.isGuest) throw new AppError(ErrorCode.ACCOUNT_NOT_GUEST);
        if (await this.users.emailExists(email, session)) throw new AppError(ErrorCode.ACCOUNT_EMAIL_TAKEN);

        await this.users.setCredentials(userId, email, passwordHash, this.clock.now(), session);
        const unbound = await this.users.deleteDeviceBindingsOf(userId, session);
        await this.users.audit(userId, "LINK_EMAIL", { unboundDevices: unbound }, session);
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new AppError(ErrorCode.ACCOUNT_EMAIL_TAKEN);
      throw error;
    }
    return this.info(userId);
  }

  /** Changes the password and signs every other device out (the calling device keeps its session). */
  async changePassword(userId: string, deviceKey: string, currentPassword: string, newPassword: string): Promise<{ revokedDevices: number }> {
    const current = await this.users.getAccountById(userId);
    if (!current) throw new AppError(ErrorCode.UNAUTHORIZED);
    if (current.isGuest) throw new AppError(ErrorCode.ACCOUNT_IS_GUEST);

    const newHash = newPassword === currentPassword ? null : await this.passwords.hash(newPassword);
    const revokedTokens = await runCommitted(this.uow, async (session) => {
      const account = await this.users.getAccountById(userId, session, true);
      if (!account) throw new AppError(ErrorCode.UNAUTHORIZED);
      if (account.isGuest) throw new AppError(ErrorCode.ACCOUNT_IS_GUEST);
      // A wrong password counts toward the login lock (committed); a locked account answers AUTH_ACCOUNT_LOCKED.
      if (!(await this.guard.verify(account, currentPassword, session))) return committedFailure(ErrorCode.ACCOUNT_WRONG_PASSWORD);
      if (!newHash) throw new AppError(ErrorCode.ACCOUNT_SAME_PASSWORD);

      await this.guard.reset(account, session);
      await this.users.updatePasswordHash(userId, newHash, this.clock.now(), session);
      const devices = await this.users.revokeRefreshTokensExcept(userId, deviceKey, session);
      await this.users.audit(userId, "PASSWORD_CHANGE", { revokedTokens: devices.length }, session);
      return devices;
    });

    const devices = new Set(revokedTokens);
    try {
      for (const removed of await this.sessions.deleteSessionsExcept(userId, deviceKey)) devices.add(removed);
    } catch (error) {
      logger.warn("other-sessions delete failed:", (error as Error).message);
    }
    return { revokedDevices: devices.size };
  }
}
