/**
 * Opaque handle for an open database transaction. Application services pass it through to
 * repository ports without knowing the underlying driver (mysql2 today).
 */
export interface DbSession {
  readonly kind: "db-session";
}

/** Runs a unit of work inside a single database transaction (commit on success, rollback on throw). */
export interface UnitOfWork {
  transaction<T>(work: (session: DbSession) => Promise<T>): Promise<T>;
}
