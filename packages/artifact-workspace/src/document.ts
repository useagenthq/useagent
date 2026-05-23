// Pure themed-document logic shared by the backend control plane and the browser.
// ONE definition of the v2 themed-document model lives here: validation (a
// security boundary for agent- and user-supplied state), deterministic v1->v2
// migration (bare rich-HTML -> themed document) and the theme-dropping v2->v1
// downgrade, plus the theme presets the picker reuses. No I/O, no DOM.
//
// A themed document reuses the deck theme shape (background + heading/body/accent
// colors); its presets ARE the deck presets so the picker is shared. The rich
// HTML body is validated through the shared rich-HTML subset. Plain-text source
// documents keep the separate `{ text }` state (no theme) and are preserved by
// `coerceDocumentState` untouched.

import {
  DOCUMENT_SCHEMA_VERSION,
  type DeckBackground,
  type DocumentTheme,
  type ThemedDocument,
} from "./contracts";
import { DECK_THEME_PRESETS, DEFAULT_DECK_THEME } from "./presentation";
import { normalizeArtifactRichHtml } from "./rich-html";

/** Per-string ceiling so one pathological body cannot bloat validation before the
 * overall MAX_WORKPIECE_STATE_BYTES check catches it. */
const MAX_DOCUMENT_HTML_LENGTH = 500_000;
const MAX_DOCUMENT_TEXT_LENGTH = 500_000;

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** A rich-HTML body is safe when it is a string within the length ceiling, free of
 * control characters, and limited to the deliberately small safe tag subset. */
function safeDocumentHtml(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_DOCUMENT_HTML_LENGTH) return null;
  if (CONTROL_CHARS.test(value)) return null;
  return normalizeArtifactRichHtml(value);
}

/** An image/background URL is safe when it is a same-origin relative path or an
 * https URL; everything else (javascript:, data:, http:) fails closed. Mirrors the
 * deck's `safeAssetUrl` (backgrounds share the same union). */
function safeAssetUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (CONTROL_CHARS.test(value)) return false;
  return value.startsWith("/") || value.startsWith("https://");
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

// --- Theme presets (shared with the deck) ----------------------------------

/** The document theme presets ARE the deck presets, so the picker is identical
 * (the task's "reuse the deck's preset pattern"). */
export const DOCUMENT_THEME_PRESETS: readonly Readonly<{
  id: string;
  label: string;
  theme: DocumentTheme;
}>[] = DECK_THEME_PRESETS;

export const DEFAULT_DOCUMENT_THEME: DocumentTheme = DEFAULT_DECK_THEME;

// --- Validation / normalization (fails closed) -----------------------------

function normalizeBackground(value: unknown): DeckBackground | null {
  const item = record(value);
  if (!item) return null;
  if (item.type === "color") {
    return isHexColor(item.color) ? { type: "color", color: item.color } : null;
  }
  if (item.type === "gradient") {
    if (!isHexColor(item.from) || !isHexColor(item.to)) return null;
    const angle = clampNumber(item.angle, 0, 360, 160);
    return { type: "gradient", from: item.from, to: item.to, angle };
  }
  if (item.type === "image") {
    return safeAssetUrl(item.url) ? { type: "image", url: item.url } : null;
  }
  return null;
}

export function normalizeDocumentTheme(value: unknown): DocumentTheme | null {
  const item = record(value);
  if (!item) return null;
  const background = normalizeBackground(item.background);
  if (
    !background || !isHexColor(item.heading) || !isHexColor(item.body) || !isHexColor(item.accent)
  ) {
    return null;
  }
  return { background, heading: item.heading, body: item.body, accent: item.accent };
}

/** Validate an unknown value into a canonical v2 themed document, or null. Fails
 * closed: bad structure, an invalid theme, or a body outside the safe rich-HTML
 * subset (or over the length ceiling) all yield null. */
export function normalizeDocument(value: unknown): ThemedDocument | null {
  const item = record(value);
  if (!item) return null;
  if (item.schemaVersion !== DOCUMENT_SCHEMA_VERSION) return null;
  const theme = normalizeDocumentTheme(item.theme);
  if (!theme) return null;
  const html = safeDocumentHtml(item.html);
  if (html === null) return null;
  return { schemaVersion: DOCUMENT_SCHEMA_VERSION, theme, html };
}

// --- Deterministic migration (v1 <-> v2) -----------------------------------

/** Deterministically upgrade a v1 rich-HTML body into a themed v2 document. Pure:
 * the same html + theme always produce the same document. Returns null when the
 * body is not the safe rich-HTML subset (the same gate as the write boundary). */
export function migrateHtmlToDocument(
  html: string,
  theme: DocumentTheme = DEFAULT_DOCUMENT_THEME,
): ThemedDocument | null {
  const safe = safeDocumentHtml(html);
  if (safe === null) return null;
  const normalizedTheme = normalizeDocumentTheme(theme) ?? DEFAULT_DOCUMENT_THEME;
  return { schemaVersion: DOCUMENT_SCHEMA_VERSION, theme: normalizedTheme, html: safe };
}

/** Downgrade a themed document to a v1 rich-HTML body. Lossy by design: the theme
 * (background + colors) is dropped, but the whole HTML content survives - the
 * documented v2 -> v1 edge. */
export function documentToHtml(doc: ThemedDocument): string {
  return doc.html;
}

// --- Coercion into canonical state -----------------------------------------

/** A safe plain-text body: a string within the length ceiling and free of control
 * characters (the `{ text }` source-document form carries no theme). */
function safeDocumentText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_DOCUMENT_TEXT_LENGTH &&
    !CONTROL_CHARS.test(value);
}

/** Coerce any accepted rich-document input into a canonical v2 themed document:
 *  - `{ document }`      -> validate the themed document
 *  - a bare document     -> validate it directly
 *  - `{ html }`          -> migrate the rich-HTML body to a themed document
 * Returns null on anything invalid. */
export function coerceDocument(value: unknown): ThemedDocument | null {
  const item = record(value);
  if (!item) return null;
  if ("document" in item) return normalizeDocument(item.document);
  if (item.schemaVersion === DOCUMENT_SCHEMA_VERSION) return normalizeDocument(item);
  if ("html" in item) return typeof item.html === "string" ? migrateHtmlToDocument(item.html) : null;
  return null;
}

/** Coerce any accepted document input into a canonical document state. This is the
 * single upgrade-on-load path both the backend (write + read boundaries) and the
 * browser funnel through:
 *  - `{ text }`  -> a validated plain-text source document (no theme)
 *  - everything else (`{ html }` / `{ document }` / bare document) -> themed `{ document }`.
 * Returns null on anything invalid. */
export function coerceDocumentState(
  value: unknown,
): Readonly<{ text: string }> | Readonly<{ document: ThemedDocument }> | null {
  const item = record(value);
  if (!item) return null;
  if ("text" in item && !("html" in item) && !("document" in item)) {
    return safeDocumentText(item.text) ? { text: item.text } : null;
  }
  const doc = coerceDocument(value);
  return doc ? { document: doc } : null;
}

// --- Editor helpers ---------------------------------------------------------

/** A fresh themed document with the supplied body and the default theme. */
export function emptyThemedDocument(
  html = "",
  theme: DocumentTheme = DEFAULT_DOCUMENT_THEME,
): ThemedDocument {
  return { schemaVersion: DOCUMENT_SCHEMA_VERSION, theme, html };
}

export { DOCUMENT_SCHEMA_VERSION };
