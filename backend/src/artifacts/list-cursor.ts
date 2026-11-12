/**
 * The cursor `GET /api/artifacts` hands back as `next_cursor`: the sort key of
 * the last artifact on a page (newest first, then id). The timestamp keeps
 * Postgres' own text form, microseconds included; a JavaScript Date would
 * round it to milliseconds and repeat or skip artifacts published within one
 * millisecond of each other.
 */
export interface ArtifactListCursor {
  readonly createdAt: string;
  readonly id: string;
}

export class InvalidArtifactCursorError extends Error {
  constructor() {
    super("cursor is invalid");
    this.name = "InvalidArtifactCursorError";
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

export function encodeArtifactCursor(cursor: ArtifactListCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, created_at: cursor.createdAt, id: cursor.id }), "utf8").toString("base64url");
}

/** Read a cursor from `encodeArtifactCursor`; anything else throws `InvalidArtifactCursorError`. */
export function parseArtifactCursor(value: string): ArtifactListCursor {
  if (!value || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw new InvalidArtifactCursorError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new InvalidArtifactCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new InvalidArtifactCursorError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidArtifactCursorError();
  const wire = parsed as Record<string, unknown>;
  const keys = Object.keys(wire).sort();
  if (keys.join(",") !== "created_at,id,v" || wire.v !== 1) throw new InvalidArtifactCursorError();
  const { created_at: createdAt, id } = wire;
  if (typeof createdAt !== "string" || !isRealTimestamp(createdAt)) throw new InvalidArtifactCursorError();
  if (typeof id !== "string" || !UUID.test(id)) throw new InvalidArtifactCursorError();
  return { createdAt, id: id.toLowerCase() };
}
