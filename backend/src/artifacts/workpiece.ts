import type { ArtifactWorkpieceKind, ArtifactWorkpieceState } from "../db/schema";

export const MAX_WORKPIECE_STATE_BYTES = 1_000_000;

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
): ArtifactWorkpieceKind | null {
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const suffix = extension(name);
  if (mime === "text/csv" || suffix === "csv") return "spreadsheet";
  if (
    DOCUMENT_MIME_TYPES.has(mime) ||
    DOCUMENT_EXTENSIONS.has(suffix)
  ) {
    return "document";
  }
  return null;
}

function isSingleStringRecord(
  value: unknown,
  key: "csv" | "text",
): value is Record<typeof key, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 1 && entries[0]?.[0] === key && typeof entries[0][1] === "string";
}

export function parseWorkpieceState(
  kind: ArtifactWorkpieceKind,
  value: unknown,
): ArtifactWorkpieceState | null {
  const key = kind === "spreadsheet" ? "csv" : "text";
  if (!isSingleStringRecord(value, key)) return null;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_WORKPIECE_STATE_BYTES
    ? value
    : null;
}
