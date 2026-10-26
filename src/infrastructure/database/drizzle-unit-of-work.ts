// Drizzle-backed unit of work and repository base (the only database layer of the server).

import { sql } from "drizzle-orm";

import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import type { Database } from "./drizzle.js";

/** Transaction handle passed by `db.transaction()`. */
export type DrizzleTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Either the root database or an open transaction. */
export type DrizzleExecutor = Database | DrizzleTransaction;

/** Drizzle implementation of {@link DbSession}: wraps the transaction. */
export class DrizzleSession implements DbSession {
  readonly kind = "db-session" as const;
  constructor(readonly tx: DrizzleTransaction) {}
}

/** MySQL/MariaDB deadlock: errno 1213 (ER_LOCK_DEADLOCK), SQLSTATE 40001. */
export function isDeadlockError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const { errno, code, sqlState, cause } = current as { errno?: unknown; code?: unknown; sqlState?: unknown; cause?: unknown };
    if (errno === 1213 || code === "ER_LOCK_DEADLOCK" || sqlState === "40001") return true;
    current = cause;
  }
  return false;
}

/**
 * Runs work in a database transaction (rolled back when the work throws). A deadlock victim is re-run in a fresh
 * transaction (twice at most), so callbacks keep non-database side effects after the commit.
 */
export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(
    private readonly database: Database,
    private readonly lockWaitTimeoutSeconds = 5,
    private readonly maxRetries = 2,
  ) {}

  async transaction<T>(work: (session: DbSession) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.database.transaction(async (tx) => {
          await tx.execute(sql`SET SESSION innodb_lock_wait_timeout = ${Math.max(1, Math.floor(this.lockWaitTimeoutSeconds))}`);
          return work(new DrizzleSession(tx));
        });
      } catch (error) {
        if (attempt >= this.maxRetries || !isDeadlockError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt * (1 + Math.random())));
      }
    }
  }
}

/** Base class of every repository: `db(session)` = the caller's transaction or the root database. */
export abstract class DrizzleRepository {
  constructor(protected readonly database: Database) {}

  protected db(session?: DbSession): DrizzleExecutor {
    if (!session) return this.database;
    if (session instanceof DrizzleSession) return session.tx;
    throw new Error("Repository received a foreign DbSession.");
  }
}

/** Affected rows of an INSERT/UPDATE/DELETE result (mysql2 `[ResultSetHeader, fields]`). */
export function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return Number((header as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}
