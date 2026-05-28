/**
 * Parse the LLM's XML wiki-structure response into a typed model.
 *
 * Ported to TypeScript from deepwiki-open (AsyncFuncAI/deepwiki-open, MIT
 * License, (c) 2024 Sheing Ng) — api/services/wiki/structure.py. The reference
 * tries strict ElementTree parsing then falls back to regex; the model's XML is
 * routinely malformed (bare `&`, unclosed tags), so we parse by regex directly,
 * which is exactly the reference's robust fallback path. Raises if no
 * <wiki_structure> block is present at all.
 */

export type Importance = "high" | "medium" | "low";

export interface WikiPage {
  id: string;
  title: string;
  filePaths: string[];
  importance: Importance;
  relatedPages: string[];
}

export interface WikiSection {
  id: string;
  title: string;
  pages: string[];
  subsections: string[];
}

export interface WikiStructure {
  title: string;
  description: string;
  pages: WikiPage[];
  sections: WikiSection[];
}

export class WikiStructureError extends Error {}

function normalizeImportance(value: string | null | undefined): Importance {
  const v = (value ?? "").trim().toLowerCase();
  return v === "high" || v === "medium" || v === "low" ? v : "medium";
}

/** All inner texts of a repeated `<tag>...</tag>` within a block, trimmed + non-empty. */
function allTags(block: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  for (const m of block.matchAll(re)) {
    const t = (m[1] ?? "").trim();
    if (t) out.push(t);
  }
  return out;
}

/** First inner text of `<tag>...</tag>` within a block, or null. */
function firstTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? (m[1] ?? "").trim() : null;
}

function parsePages(xml: string): WikiPage[] {
  const pages: WikiPage[] = [];
  const blocks = xml.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/gi);
  let i = 0;
  for (const m of blocks) {
    const attrs = m[1] ?? "";
    const block = m[2] ?? "";
    const idMatch = attrs.match(/\bid="([^"]+)"/i);
    pages.push({
      id: idMatch ? idMatch[1]! : `page-${i + 1}`,
      title: firstTag(block, "title") ?? "",
      filePaths: allTags(block, "file_path"),
      importance: normalizeImportance(firstTag(block, "importance")),
      relatedPages: allTags(block, "related"),
    });
    i += 1;
  }
  return pages;
}

function parseSections(xml: string): WikiSection[] {
  const sections: WikiSection[] = [];
  const blocks = xml.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi);
  let i = 0;
  for (const m of blocks) {
    const attrs = m[1] ?? "";
    const block = m[2] ?? "";
    const idMatch = attrs.match(/\bid="([^"]+)"/i);
    sections.push({
      id: idMatch ? idMatch[1]! : `section-${i + 1}`,
      title: firstTag(block, "title") ?? "",
      pages: allTags(block, "page_ref"),
      subsections: allTags(block, "section_ref"),
    });
    i += 1;
  }
  return sections;
}

/**
 * Parse the LLM's XML response into a WikiStructure. Strips markdown fences and
 * control chars first; robust against the model's usual malformations. Throws
 * WikiStructureError when no <wiki_structure> block is present.
 */
export function parseWikiStructure(text: string, comprehensive: boolean): WikiStructure {
  const stripped = text.trim().replace(/^```(?:xml)?\s*/i, "").replace(/```\s*$/, "");

  const complete = stripped.match(/<wiki_structure>[\s\S]*?<\/wiki_structure>/i)?.[0];
  const rootStart = stripped.search(/<wiki_structure>/i);
  const truncated = rootStart >= 0 ? stripped.slice(rootStart) : null;
  const recoverable = truncated && /<page\b[^>]*>[\s\S]*?<\/page>/i.test(truncated)
    ? `${truncated}</wiki_structure>`
    : null;
  const matchedXml = complete ?? recoverable;
  if (!matchedXml) {
    throw new WikiStructureError("No valid <wiki_structure> XML found in response");
  }
  // Strip control chars that break downstream rendering (bare `&` needs no
  // escaping here since we never hand this to a strict XML parser).
  const xml = matchedXml.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Title/description are the FIRST such tags, which the prompt places directly
  // under <wiki_structure> before any <page>/<section>.
  const title = firstTag(xml, "title") ?? "";
  const description = firstTag(xml, "description") ?? "";

  const pages = parsePages(xml);
  const sections = comprehensive ? parseSections(xml) : [];

  return { title, description, pages, sections };
}
