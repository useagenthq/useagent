/**
 * The cursor a newest-first list hands back as `next_cursor` (`GET
 * /api/artifacts`, an automation's history): the sort key of the last row on a
 * page, its timestamp and then its uuid. The timestamp keeps Postgres' own text
 * form (select it as `::text`), microseconds included; a JavaScript Date would
 * round it to milliseconds and repeat or skip rows written within one
 * millisecond of each other. The page after it is the rows whose
 * `(time, id)` is below the cursor's.
 */
export interface ListCursor {
  readonly createdAt: string;
  readonly id: string;
}

export class InvalidListCursorError extends Error {
  constructor() {
    super("cursor is invalid");
    this.name = "InvalidListCursorError";
  }
}

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

export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, created_at: cursor.createdAt, id: cursor.id }), "utf8").toString("base64url");
}

/** Read a cursor from `encodeListCursor`; anything else throws `InvalidListCursorError`. */
export function parseListCursor(value: string): ListCursor {
  if (!value || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidListCursorError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new InvalidListCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new InvalidListCursorError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidListCursorError();
  const wire = parsed as Record<string, unknown>;
  const keys = Object.keys(wire).sort();
  if (keys.join(",") !== "created_at,id,v" || wire.v !== 1) throw new InvalidListCursorError();
  const { created_at: createdAt, id } = wire;
  if (typeof createdAt !== "string" || !isRealTimestamp(createdAt)) throw new InvalidListCursorError();
  if (typeof id !== "string" || !UUID.test(id)) throw new InvalidListCursorError();
  return { createdAt, id: id.toLowerCase() };
}
