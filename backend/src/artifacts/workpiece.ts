import type { ArtifactWorkpieceKind, ArtifactWorkpieceState } from "../db/schema";

export const MAX_WORKPIECE_STATE_BYTES = 1_000_000;
export const MAX_RICH_WORKPIECE_SOURCE_BYTES = 10_000_000;

const RICH_DOCUMENT_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const RICH_SPREADSHEET_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const DOCUMENT_EXTENSIONS = new Set([
  "json",
  "markdown",
  "md",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

const DOCUMENT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  RICH_DOCUMENT_MIME_TYPE,
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/x-markdown",
]);

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Pure behavior/schema registry. It contains no tenant data and is shared by
 * artifact creation and state validation rather than inferred from prompts. */
export function inferWorkpieceKind(
  name: string,
  contentType: string,
  sizeBytes = 0,
): ArtifactWorkpieceKind | null {
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const suffix = extension(name);
  const isOfficeDocument =
    mime === RICH_DOCUMENT_MIME_TYPE ||
    suffix === "docx";
  const isOfficeSpreadsheet =
    mime === RICH_SPREADSHEET_MIME_TYPE || suffix === "xlsx";
  if (sizeBytes > MAX_RICH_WORKPIECE_SOURCE_BYTES && (isOfficeDocument || isOfficeSpreadsheet)) {
    return null;
  }
  if (isOfficeSpreadsheet) return "spreadsheet";
  if (mime === "text/csv" || suffix === "csv") return "spreadsheet";
  if (
    DOCUMENT_MIME_TYPES.has(mime) ||
    DOCUMENT_EXTENSIONS.has(suffix)
  ) {
    return "document";
  }
  return null;
}

function isWorkpieceState(
  kind: ArtifactWorkpieceKind,
  value: unknown,
): value is ArtifactWorkpieceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  const entry = entries[0];
  if (entry === undefined || entries.length !== 1 || typeof entry[1] !== "string") {
    return false;
  }
  const keyMatchesKind = kind === "spreadsheet"
    ? entry[0] === "csv"
    : entry[0] === "text" || entry[0] === "html";
  return keyMatchesKind;
}

const SAFE_HTML_TAGS = new Set([
  "a", "b", "br", "div", "em", "h1", "h2", "h3", "i", "li", "ol", "p",
  "strong", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
]);
const TABLE_CELL_TAGS = new Set(["td", "th"]);

function safeHref(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("https://") ||
    normalized.startsWith("http://") ||
    normalized.startsWith("mailto:");
}

function safeAttributes(tag: string, source: string): boolean {
  let remaining = source.trim();
  if (!remaining) return true;
  if (remaining.endsWith("/")) {
    if (tag !== "br") return false;
    remaining = remaining.slice(0, -1).trimEnd();
  }

  const seen = new Set<string>();
  while (remaining) {
    const match = /^([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))(?:\s+|$)/i.exec(remaining);
    if (!match) return false;
    const name = match[1]!.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (seen.has(name)) return false;
    seen.add(name);

    if (name === "href") {
      if (tag !== "a" || !safeHref(value)) return false;
    } else if (name === "colspan" || name === "rowspan") {
      const span = Number(value);
      if (!TABLE_CELL_TAGS.has(tag) || !/^\d{1,3}$/.test(value) || span < 1 || span > 100) {
        return false;
      }
    } else {
      return false;
    }
    remaining = remaining.slice(match[0].length);
  }
  return true;
}

/** Validate a deliberately small, presentation-only HTML subset. Browsers
 * perform surprising entity and malformed-markup recovery, so a blacklist is
 * insufficient at this tenant boundary. Unknown tags, attributes and URL
 * schemes fail closed instead of being stored for later interpretation. */
function isSafeRichHtml(value: string): boolean {
  const tags = value.matchAll(/<[^>]*>/g);
  let cursor = 0;
  for (const match of tags) {
    const start = match.index;
    if (start === undefined || /[<>]/.test(value.slice(cursor, start))) return false;
    const parsed = /^<\s*(\/?)\s*([a-z][a-z0-9]*)\s*([^>]*)>$/i.exec(match[0]);
    if (!parsed) return false;
    const closing = parsed[1] === "/";
    const tag = parsed[2]!.toLowerCase();
    const attributes = parsed[3] ?? "";
    if (!SAFE_HTML_TAGS.has(tag)) return false;
    if (closing ? attributes.trim() !== "" : !safeAttributes(tag, attributes)) return false;
    cursor = start + match[0].length;
  }
  return !/[<>]/.test(value.slice(cursor));
}

export function parseWorkpieceState(
  kind: ArtifactWorkpieceKind,
  value: unknown,
): ArtifactWorkpieceState | null {
  if (!isWorkpieceState(kind, value)) return null;
  if ("html" in value && !isSafeRichHtml(value.html)) return null;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_WORKPIECE_STATE_BYTES
    ? value
    : null;
}
