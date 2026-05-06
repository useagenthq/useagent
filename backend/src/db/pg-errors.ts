/**
 * Typed predicates over postgres-js driver errors. The driver surfaces a
 * `PostgresError` carrying the server's SQLSTATE `code`; we branch on those
 * codes explicitly instead of string-matching messages, so a caller can tell a
 * genuine unique-constraint race apart from an unexpected failure and never
 * swallows the latter.
 *
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */

/** SQLSTATE 23505 — a row violated a UNIQUE constraint / index. */
const UNIQUE_VIOLATION = "23505";

function sqlStateOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** True when `err` is a unique-constraint violation (e.g. a concurrent request
 *  lost the race for an idempotency key). */
export function isUniqueViolation(err: unknown): boolean {
  return sqlStateOf(err) === UNIQUE_VIOLATION;
}
