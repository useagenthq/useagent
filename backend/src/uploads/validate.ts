// Leaf helpers for an inbound upload's file name. No HTTP/Hono deps so
// non-route callers (e.g. slack/inbound-files.ts) can reuse them without
// importing the uploads route module.

/**
 * The name a multipart file part arrived with, or "" when it has none. Bun's
 * FormData parser (1.3) returns a File whose `name` is undefined, despite its
 * type, when the part's body is empty or its filename is "" (#412). Read a
 * parsed upload's name through here, never `file.name` directly.
 */
export function multipartFileName(file: File): string {
  const name: unknown = file.name;
  return typeof name === "string" ? name : "";
}

/** Normalize + bound an upload file name; null when it is empty, too long, or
 *  carries path/control characters. */
export function validateUploadName(raw: string): string | null {
  const name = raw.normalize("NFKC").trim();
  if (!name || name.length > 180 || /[\\/\0\r\n]/.test(name)) return null;
  return name;
}
