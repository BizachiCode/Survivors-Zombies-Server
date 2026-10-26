// Driver error helpers. Drizzle wraps driver failures (DrizzleQueryError), so the mysql2 code lives on `cause`.

/** True when `error` (or one of its causes) is a MySQL/MariaDB duplicate-key violation. */
export function isDuplicateKeyError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const candidate = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062) return true;
    current = candidate.cause;
  }
  return false;
}
