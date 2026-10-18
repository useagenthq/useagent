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
/** SQLSTATE 55P03 — a lock was not acquired within lock_timeout. */
const LOCK_NOT_AVAILABLE = "55P03";

export function sqlStateOf(err: unknown): string | undefined {
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

/** The driver's own error for a log line: drizzle's wrapper message is the
 *  whole statement and its parameters, the SQLSTATE and reason sit on its cause. */
export function dbErrorDetail(err: unknown): string {
  let cur: unknown = err;
  let innermost: unknown = err;
  for (let depth = 0; typeof cur === "object" && cur !== null && depth < 5; depth++) {
    const { code, message, constraint_name: constraint } = cur as { code?: unknown; message?: unknown; constraint_name?: unknown };
    if (typeof code === "string") {
      return [code, String(message ?? ""), typeof constraint === "string" ? `(${constraint})` : ""].filter(Boolean).join(" ");
    }
    innermost = cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  const message = innermost instanceof Error ? innermost.message : String(innermost);
  return message.startsWith("Failed query") ? "query failed without a driver error" : message;
}

/** True when `err` is a unique-constraint violation (e.g. a concurrent request
 *  lost the race for an idempotency key). */
export function isUniqueViolation(err: unknown): boolean {
  return sqlStateOf(err) === UNIQUE_VIOLATION;
}

/** True when `err` is a lock wait cut short by the transaction's lock_timeout. */
export function isLockTimeout(err: unknown): boolean {
  return sqlStateOf(err) === LOCK_NOT_AVAILABLE;
}

/** Failures a retry can outlive: serialization and deadlock aborts, lock
 *  timeouts, a server shutting down or out of connections, and the driver's or
 *  socket's lost-connection codes. Class 08 is every connection exception. */
const TRANSIENT_CODES = new Set([
  "40001", "40P01", LOCK_NOT_AVAILABLE, "57P01", "57P02", "57P03", "53300",
  "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE",
]);

/** True when `err` is a database failure that the same work may survive on a retry. */
export function isTransientDbError(err: unknown): boolean {
  const code = sqlStateOf(err);
  return code !== undefined && (TRANSIENT_CODES.has(code) || code.startsWith("08"));
}
