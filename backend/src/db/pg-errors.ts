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
  // Walk the cause chain: drizzle wraps the driver error (DrizzleQueryError,
  // code=undefined — the SQLSTATE lives on err.cause), so inspecting only the
  // top level made every caller blind under drizzle (soak DEFECT-1: concurrent
  // idempotent POSTs 500ed instead of replaying the winner).
  let cur: unknown = err;
  for (let depth = 0; typeof cur === "object" && cur !== null && depth < 5; depth++) {
    if ("code" in cur) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** True when `err` is a unique-constraint violation (e.g. a concurrent request
 *  lost the race for an idempotency key). */
export function isUniqueViolation(err: unknown): boolean {
  return sqlStateOf(err) === UNIQUE_VIOLATION;
}
