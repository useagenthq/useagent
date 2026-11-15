/**
 * The `cursor` of the paged knowledge lists: a page's last sort key, as opaque
 * base64url text. `GET /api/knowledge` keys on pinned first, then newest first
 * (see `listRecordPage` in ./store); the wiki document list on the newest
 * update, and a document's revisions on the newest revision (see ./wiki).
 * Creation and update times are whole microseconds since the epoch, as
 * decimal strings, so rows written in the same millisecond page cleanly.
 */
import type { RecordPageCursor } from "./store";
import type { DocumentPageCursor, RevisionPageCursor } from "./wiki";

const MAX_CURSOR_LENGTH = 512;
/** 9999-12-31T23:59:59.999999Z, the last instant Postgres timestamps reach in this form. */
const MAX_CURSOR_MICROSECONDS = 253_402_300_799_999_999n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursorKey(key: readonly unknown[]): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/** The sort key inside a cursor, when it is a JSON array of `length` values. */
function decodeCursorKey(value: string, length: number): unknown[] | null {
  if (!value || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return Array.isArray(decoded) && decoded.length === length ? decoded : null;
}

function isMicroseconds(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9]{1,18}$/.test(value) &&
    BigInt(value) <= MAX_CURSOR_MICROSECONDS
  );
}

function isRowId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function encodeRecordPageCursor(cursor: RecordPageCursor): string {
  return encodeCursorKey([cursor.pinned, cursor.createdAtMicros, cursor.id]);
}

/** Decode a cursor from `encodeRecordPageCursor`; null for anything else. */
export function parseRecordPageCursor(value: string): RecordPageCursor | null {
  const key = decodeCursorKey(value, 3);
  if (!key) return null;
  const [pinned, createdAtMicros, id] = key;
  if (typeof pinned !== "boolean" || !isMicroseconds(createdAtMicros) || !isRowId(id)) {
    return null;
  }
  return { pinned, createdAtMicros, id };
}

export function encodeDocumentPageCursor(cursor: DocumentPageCursor): string {
  return encodeCursorKey([cursor.updatedAtMicros, cursor.createdAtMicros, cursor.id]);
}

/** Decode a cursor from `encodeDocumentPageCursor`; null for anything else. */
export function parseDocumentPageCursor(value: string): DocumentPageCursor | null {
  const key = decodeCursorKey(value, 3);
  if (!key) return null;
  const [updatedAtMicros, createdAtMicros, id] = key;
  if (!isMicroseconds(updatedAtMicros) || !isMicroseconds(createdAtMicros) || !isRowId(id)) {
    return null;
  }
  return { updatedAtMicros, createdAtMicros, id };
}

export function encodeRevisionPageCursor(cursor: RevisionPageCursor): string {
  return encodeCursorKey([cursor.createdAtMicros, cursor.id]);
}

/** Decode a cursor from `encodeRevisionPageCursor`; null for anything else. */
export function parseRevisionPageCursor(value: string): RevisionPageCursor | null {
  const key = decodeCursorKey(value, 2);
  if (!key) return null;
  const [createdAtMicros, id] = key;
  if (!isMicroseconds(createdAtMicros) || !isRowId(id)) return null;
  return { createdAtMicros, id };
}
