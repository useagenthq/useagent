/**
 * The short preview the wiki document list sends in place of a document's
 * content: its first line of prose, the way the Wiki page's cards read it.
 * Generated pages open with a "Relevant source files" disclosure and their
 * own title as a heading; neither is a preview, so both are skipped.
 */

/** How much of a document's start the list reads to find its first line. A
 *  generated page's source-file disclosure, a few dozen links, fits well
 *  inside it. */
export const WIKI_EXCERPT_SOURCE_CHARS = 8000;
/** Longest excerpt, in characters; the Wiki cards show two lines. */
export const WIKI_EXCERPT_MAX_CHARS = 280;

const SOURCE_FILES_DISCLOSURE =
  /<details>\s*<summary>\s*Relevant source files\s*<\/summary>[\s\S]*?<\/details>/g;
/** A disclosure whose end was cut off when only the start of the content was read. */
const OPEN_SOURCE_FILES_DISCLOSURE = /<details>\s*<summary>\s*Relevant source files\s*<\/summary>[\s\S]*$/;

/** The first line of prose in `content` that is not the title, clipped to
 *  `WIKI_EXCERPT_MAX_CHARS`; "" when there is none. */
export function wikiDocumentExcerpt(content: string, title: string): string {
  const line =
    content
      .replace(SOURCE_FILES_DISCLOSURE, "\n")
      .replace(OPEN_SOURCE_FILES_DISCLOSURE, "")
      .split("\n")
      .map((text) => text.replace(/^#+\s*/, "").trim())
      .find((text) => text.length > 0 && text !== title.trim()) ?? "";
  // Count code points, so a cut never splits an emoji's surrogate pair.
  const chars = Array.from(line);
  if (chars.length <= WIKI_EXCERPT_MAX_CHARS) return line;
  return `${chars.slice(0, WIKI_EXCERPT_MAX_CHARS - 1).join("").trimEnd()}…`;
}
