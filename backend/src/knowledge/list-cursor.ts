/**
 * The `cursor` of `GET /api/knowledge`: a record page's last sort key, as
 * opaque base64url text. The key is the list order, pinned first, then newest
 * first (see `listRecordPage` in ./store).
 */
import type { RecordPageCursor } from "./store";

const MAX_CURSOR_LENGTH = 512;
/** 9999-12-31T23:59:59.999999Z, the last instant Postgres timestamps reach in this form. */
const MAX_CURSOR_MICROSECONDS = 253_402_300_799_999_999n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeRecordPageCursor(cursor: RecordPageCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.pinned, cursor.createdAtMicros, cursor.id]),
    "utf8",
  ).toString("base64url");
}

/** Decode a cursor from `encodeRecordPageCursor`; null for anything else. */
export function parseRecordPageCursor(value: string): RecordPageCursor | null {
  if (!value || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length !== 3) return null;
  const [pinned, createdAtMicros, id] = decoded as unknown[];
  if (
    typeof pinned !== "boolean" ||
    typeof createdAtMicros !== "string" ||
    !/^[0-9]{1,18}$/.test(createdAtMicros) ||
    BigInt(createdAtMicros) > MAX_CURSOR_MICROSECONDS ||
    typeof id !== "string" ||
    !UUID_RE.test(id)
  ) {
    return null;
  }
  return { pinned, createdAtMicros, id };
}
