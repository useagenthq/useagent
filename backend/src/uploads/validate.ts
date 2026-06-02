// Leaf helper for validating an inbound upload's file name. No HTTP/Hono deps so
// non-route callers (e.g. slack/inbound-files.ts) can reuse it without importing
// the uploads route module.

/** Normalize + bound an upload file name; null when it is empty, too long, or
 *  carries path/control characters. */
export function validateUploadName(raw: string): string | null {
  const name = raw.normalize("NFKC").trim();
  if (!name || name.length > 180 || /[\\/\0\r\n]/.test(name)) return null;
  return name;
}
