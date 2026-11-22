/**
 * The `before` cursor the firing-history routes accept: the sort key of the
 * last firing on the page just returned (fired_at newest first, then the id).
 * The timestamp keeps Postgres' own text form, microseconds included; a
 * JavaScript Date would round it to milliseconds and repeat or skip firings
 * recorded within one millisecond of each other.
 */
export interface FiringCursor {
  readonly firedAt: string;
  readonly id: string;
}

export class InvalidFiringCursorError extends Error {
  constructor() {
    super("cursor is invalid");
    this.name = "InvalidFiringCursorError";
  }
}

export const FIRING_HISTORY_DEFAULT_LIMIT = 50;
export const FIRING_HISTORY_MAX_LIMIT = 200;

const MAX_CURSOR_LENGTH = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSTGRES_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::?\d{2})?$/;

/** Postgres rejects a calendar date or clock time that does not exist (and
 *  `Date.parse` may roll it over), so the parts are checked before the query. */
function isRealTimestamp(value: string): boolean {
  if (!POSTGRES_TIMESTAMP.test(value)) return false;
  const [year, month, day, hour, minute, second] = value.split(/[- :.+]/, 6).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

export function encodeFiringCursor(cursor: FiringCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, fired_at: cursor.firedAt, id: cursor.id }), "utf8").toString("base64url");
}

/** Read a cursor from `encodeFiringCursor`; anything else throws `InvalidFiringCursorError`. */
export function parseFiringCursor(value: string): FiringCursor {
  if (!value || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidFiringCursorError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new InvalidFiringCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new InvalidFiringCursorError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidFiringCursorError();
  const wire = parsed as Record<string, unknown>;
  const keys = Object.keys(wire).sort();
  if (keys.join(",") !== "fired_at,id,v" || wire.v !== 1) throw new InvalidFiringCursorError();
  const { fired_at: firedAt, id } = wire;
  if (typeof firedAt !== "string" || !isRealTimestamp(firedAt)) throw new InvalidFiringCursorError();
  if (typeof id !== "string" || !UUID.test(id)) throw new InvalidFiringCursorError();
  return { firedAt, id: id.toLowerCase() };
}

/** The page a firing-history request asks for: `limit` bounded to
 *  1..FIRING_HISTORY_MAX_LIMIT (absent or unreadable means the default) and
 *  `before` decoded by `parseFiringCursor`, which throws
 *  `InvalidFiringCursorError` on anything it did not encode. */
export function firingHistoryPage(
  rawLimit: string | undefined,
  rawBefore: string | undefined,
): { limit: number; before: FiringCursor | null } {
  const requestedLimit = Number.parseInt(rawLimit ?? `${FIRING_HISTORY_DEFAULT_LIMIT}`, 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(FIRING_HISTORY_MAX_LIMIT, Math.max(1, requestedLimit))
    : FIRING_HISTORY_DEFAULT_LIMIT;
  return { limit, before: rawBefore === undefined ? null : parseFiringCursor(rawBefore) };
}
