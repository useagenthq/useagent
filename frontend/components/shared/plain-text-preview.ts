/**
 * Derive a plain-text preview from markdown / HTML source. Knowledge bodies
 * arrive as raw markdown that often carries literal (or entity-escaped) HTML
 * like "<details><summary>...", which must never render as visible markup in a
 * list-row preview. This strips frontmatter, tags, and markdown syntax, decodes
 * the common entities, collapses whitespace, and caps the length.
 *
 * Preview-only: detail/expanded views keep the full source rendering.
 */

/** Named HTML entities the distiller commonly escapes. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return " ";
  try {
    return String.fromCodePoint(n);
  } catch {
    return " ";
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => NAMED_ENTITIES[name] ?? " ")
    .replace(/&#(\d{1,7});/g, (_, dec: string) => codePoint(Number(dec)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => codePoint(parseInt(hex, 16)));
}

export function plainTextPreview(raw: string, maxLength = 240): string {
  if (!raw) return "";
  let text = raw;
  // Leading YAML frontmatter block. \s already matches a leading BOM in JS.
  text = text.replace(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, " ");
  // Fenced-code markers (keep the code text, drop the ``` fences + lang hint).
  text = text.replace(/```[a-z0-9]*/gi, " ");
  // Inline code -> its text.
  text = text.replace(/`([^`]+)`/g, "$1");
  // Decode entities first so "&lt;details&gt;" becomes a tag we then strip.
  text = decodeEntities(text);
  // HTML tags.
  text = text.replace(/<[^>]+>/g, " ");
  // Images -> alt text, links -> label text.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Line-leading markup: headings, blockquotes, list markers, thematic breaks.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "");
  text = text.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, " ");
  // Emphasis / strikethrough markers (keep inner text; underscores left alone so
  // snake_case identifiers survive).
  text = text.replace(/(\*\*|\*|~~)(.+?)\1/g, "$2");
  // Collapse whitespace and cap.
  text = text.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}
