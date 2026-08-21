const SOURCE_FILES_DISCLOSURE =
  /<details>\s*<summary>\s*Relevant source files\s*<\/summary>\s*([\s\S]*?)\s*<\/details>/g;

export type WikiContentSegment =
  | { kind: "markdown"; content: string }
  | { kind: "source-files"; content: string };

export function wikiContentSegments(content: string): WikiContentSegment[] {
  const segments: WikiContentSegment[] = [];
  let cursor = 0;

  for (const match of content.matchAll(SOURCE_FILES_DISCLOSURE)) {
    const index = match.index ?? 0;
    const before = content.slice(cursor, index);
    if (before.trim()) segments.push({ kind: "markdown", content: before });

    const disclosureContent = match[1]?.trim();
    if (disclosureContent) {
      segments.push({ kind: "source-files", content: disclosureContent });
    }
    cursor = index + match[0].length;
  }

  const after = content.slice(cursor);
  if (after.trim()) segments.push({ kind: "markdown", content: after });
  return segments;
}

export function wikiContentPreview(content: string, title: string): string {
  return wikiContentSegments(content)
    .filter((segment) => segment.kind === "markdown")
    .flatMap((segment) => segment.content.split("\n"))
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0 && line !== title) ?? "";
}
