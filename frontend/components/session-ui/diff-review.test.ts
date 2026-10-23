import { describe, expect, test } from "bun:test";
import { buildReviewMessage, type DiffComment, lineRange, quoteLines } from "./diff-review";
import { diffLinesFromEdit, parsePatchLines } from "./file-diff-view";

const PATCH = parsePatchLines(
  "--- a/src/routes.ts\n+++ b/src/routes.ts\n@@ -10,3 +10,3 @@\n keep\n-old line\n+new line\n tail",
);

function comment(overrides: Partial<DiffComment> & Pick<DiffComment, "lines" | "body">): DiffComment {
  return { id: "c", path: "src/routes.ts", hunk: 0, start: 0, end: 0, ...overrides };
}

describe("line numbers", () => {
  test("a numbered @@ header numbers the rows under it on both sides", () => {
    expect(PATCH.slice(3)).toEqual([
      { tone: "context", text: "keep", oldLine: 10, newLine: 10 },
      { tone: "del", text: "old line", oldLine: 11 },
      { tone: "add", text: "new line", newLine: 11 },
      { tone: "context", text: "tail", oldLine: 12, newLine: 12 },
    ]);
  });

  test("ranges prefer the new file, fall back to removed lines, and admit none", () => {
    expect(lineRange(PATCH.slice(3, 6))).toBe("lines 10-11");
    expect(lineRange(PATCH.slice(4, 5))).toBe("removed line 11");
    expect(lineRange(diffLinesFromEdit("a", "b"))).toBeNull();
  });
});

describe("buildReviewMessage", () => {
  test("puts every comment in one message with path, lines and quoted code", () => {
    const message = buildReviewMessage([
      comment({ id: "1", start: 4, end: 5, lines: PATCH.slice(4, 6), body: "Keep the old name. " }),
      comment({
        id: "2",
        path: "src/app.ts",
        lines: diffLinesFromEdit("const a = 1;", "const a = 10;"),
        body: "Why 10?",
      }),
    ]);
    expect(message).toBe(
      [
        "I left 2 comments on your changes. Please address each one:",
        "1. src/routes.ts, line 11\n```diff\n-old line\n+new line\n```\nKeep the old name.",
        "2. src/app.ts, line numbers not recorded, see the quoted code\n```diff\n-const a = 1;\n+const a = 10;\n```\nWhy 10?",
      ].join("\n\n"),
    );
  });

  test("orders by file first commented, then top to bottom inside a file", () => {
    const top = comment({ id: "top", start: 3, end: 3, lines: PATCH.slice(3, 4), body: "top" });
    const later = comment({ id: "later", hunk: 1, lines: PATCH.slice(6, 7), body: "later hunk" });
    const other = comment({ id: "other", path: "b.ts", lines: PATCH.slice(5, 6), body: "other file" });
    const message = buildReviewMessage([later, other, top]);
    expect(message.startsWith("I left 3 comments")).toBe(true);
    expect(message.indexOf("top")).toBeLessThan(message.indexOf("later hunk"));
    expect(message.indexOf("later hunk")).toBeLessThan(message.indexOf("other file"));
  });

  test("a single comment reads in the singular", () => {
    expect(buildReviewMessage([comment({ lines: PATCH.slice(5, 6), body: "ok" })])).toStartWith(
      "I left a comment on your changes. Please address it:",
    );
  });

  test("quoted code containing a fence gets a longer fence", () => {
    expect(quoteLines([{ tone: "add", text: "```ts" }])).toBe("````diff\n+```ts\n````");
  });
});
