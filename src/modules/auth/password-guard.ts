// Password checks shared by email login and the account room (lock + failed-login counter).

import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { randomToken, type PasswordHasher } from "../../shared/security/password-hasher.js";
import type { AccountRow, AuthRepository } from "./auth.ports.js";

/** Wrong passwords in a row before the account is locked. */
export const MAX_FAILED_LOGINS = 6;
/** Lock duration after {@link MAX_FAILED_LOGINS} failures. */
export const LOCK_MS = 60_000;

type GuardedUser = Pick<AccountRow, "id" | "passwordHash" | "failedLogins" | "lockedUntil">;

/**
 * Verifies passwords against a row locked by the caller's transaction.
 * - Locked accounts fail with `AUTH_ACCOUNT_LOCKED` (thrown: nothing to commit).
 * - A wrong password increments `failed_logins` (locking at {@link MAX_FAILED_LOGINS}) and returns false; the caller
 *   must let the transaction commit (see {@link runCommitted}) so the counter sticks.
 */
export class PasswordGuard {
  private dummyPasswordHash: Promise<string> | null = null;

  constructor(
    private readonly users: AuthRepository,
    private readonly passwords: PasswordHasher,
    private readonly clock: Clock,
  ) {}

  async verify(user: GuardedUser, password: string, session: DbSession): Promise<boolean> {
    if (user.lockedUntil && user.lockedUntil.getTime() > this.clock.nowMs()) throw new AppError(ErrorCode.AUTH_ACCOUNT_LOCKED);
    if (!user.passwordHash) {
      await this.dummyVerify(password);
      return false;
    }
    if (await this.passwords.verify(password, user.passwordHash)) return true;

    const fails = Math.min(user.failedLogins + 1, MAX_FAILED_LOGINS);
    const locked = fails >= MAX_FAILED_LOGINS;
    await this.users.setFailedLogins(user.id, locked ? 0 : fails, locked ? new Date(this.clock.nowMs() + LOCK_MS) : null, session);
    return false;
  }

  /** Clears the failed-login counter after a correct password (no write when already clean). */
  async reset(user: GuardedUser, session: DbSession): Promise<void> {
    if (user.failedLogins > 0 || user.lockedUntil) await this.users.setFailedLogins(user.id, 0, null, session);
  }

  /** Same cost as a real check, so response times don't reveal which emails exist. */
  async dummyVerify(password: string): Promise<void> {
    this.dummyPasswordHash ??= this.passwords.hash(randomToken(16));
    await this.passwords.verify(password, await this.dummyPasswordHash);
  }
}

/** Failure returned (not thrown) from a transaction so its writes (e.g. failed-login counter) commit first. */
export class CommittedFailure {
  constructor(readonly error: AppError) {}
}

export function committedFailure(code: string, extra?: Record<string, unknown>): CommittedFailure {
  return new CommittedFailure(new AppError(code, extra ? { extra } : {}));
}

/** Runs `work` in a transaction; a returned {@link CommittedFailure} is thrown after the commit. */
export async function runCommitted<T>(uow: UnitOfWork, work: (session: DbSession) => Promise<T | CommittedFailure>): Promise<T> {
  const outcome = await uow.transaction(work);
  if (outcome instanceof CommittedFailure) throw outcome.error;
  return outcome;
}
