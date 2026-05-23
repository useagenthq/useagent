// The deliberately small rich-HTML subset shared by the backend control plane and
// the browser editor. ONE definition of the safe tag/attribute set and the
// fail-closed normalizer lives here (consolidated out of index.ts, like csv.ts)
// so the themed-document model can validate its body without importing index.ts.
// No I/O, no DOM.

const SAFE_RICH_HTML_TAGS = new Set([
  "a",
  "b",
  "br",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "i",
  "li",
  "ol",
  "p",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);
const RICH_HTML_TABLE_CELL_TAGS = new Set(["td", "th"]);

export function isArtifactRichHtmlTag(tag: string): boolean {
  return SAFE_RICH_HTML_TAGS.has(tag.toLowerCase());
}

export function isArtifactRichHtmlAttribute(
  tag: string,
  name: string,
  value: string,
): boolean {
  const normalizedTag = tag.toLowerCase();
  const normalizedName = name.toLowerCase();
  if (normalizedName === "href") {
    const href = value.trim().toLowerCase();
    return normalizedTag === "a" &&
      (href.startsWith("https://") || href.startsWith("http://") || href.startsWith("mailto:"));
  }
  if (normalizedName !== "colspan" && normalizedName !== "rowspan") return false;
  if (!RICH_HTML_TABLE_CELL_TAGS.has(normalizedTag) || !/^\d{1,3}$/.test(value)) return false;
  const span = Number(value);
  return span >= 1 && span <= 100;
}

function hasSafeRichHtmlAttributes(tag: string, source: string): boolean {
  let remaining = source.trim();
  if (!remaining) return true;
  if (remaining.endsWith("/")) {
    if (tag !== "br") return false;
    remaining = remaining.slice(0, -1).trimEnd();
  }

  const seen = new Set<string>();
  while (remaining) {
    const match =
      /^([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))(?:\s+|$)/i.exec(
        remaining,
      );
    if (!match) return false;
    const rawName = match[1];
    if (!rawName) return false;
    const name = rawName.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (seen.has(name) || !isArtifactRichHtmlAttribute(tag, name, value)) return false;
    seen.add(name);
    remaining = remaining.slice(match[0].length);
  }
  return true;
}

/** Validate the browser editor's deliberately small rich-HTML subset. Unknown
 * tags, misplaced attributes, unsafe URL schemes, and malformed markup fail
 * closed so browser and server consumers enforce one storage contract. */
export function normalizeArtifactRichHtml(value: string): string | null {
  const tags = value.matchAll(/<[^>]*>/g);
  let cursor = 0;
  for (const match of tags) {
    const start = match.index;
    if (start === undefined || /[<>]/.test(value.slice(cursor, start))) return null;
    const parsed = /^<\s*(\/?)\s*([a-z][a-z0-9]*)\s*([^>]*)>$/i.exec(match[0]);
    if (!parsed) return null;
    const closing = parsed[1] === "/";
    const rawTag = parsed[2];
    if (!rawTag) return null;
    const tag = rawTag.toLowerCase();
    const attributes = parsed[3] ?? "";
    if (!isArtifactRichHtmlTag(tag)) return null;
    if (closing ? attributes.trim() !== "" : !hasSafeRichHtmlAttributes(tag, attributes)) {
      return null;
    }
    cursor = start + match[0].length;
  }
  return /[<>]/.test(value.slice(cursor)) ? null : value;
}
