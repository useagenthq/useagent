import { describe, expect, test } from "bun:test";
import { wikiDocumentExcerpt } from "./wiki-excerpt";

const GENERATED_PAGE = [
  "<details>",
  "<summary>Relevant source files</summary>",
  "",
  "- `backend/src/runs/run-admission.ts`",
  "- `backend/test/run-admission.test.ts`",
  "",
  "</details>",
  "",
  "# Run admission",
  "",
  "The run gate keeps org-scoped sessions bounded.",
].join("\n");

describe("wikiDocumentExcerpt", () => {
  test("skips the source files disclosure and the title heading", () => {
    expect(wikiDocumentExcerpt(GENERATED_PAGE, "Run admission")).toBe(
      "The run gate keeps org-scoped sessions bounded.",
    );
  });

  test("reads a heading that is not the title, without its marks", () => {
    expect(wikiDocumentExcerpt("# Onboarding\n\n## First day\n\nBring a laptop.", "Onboarding")).toBe(
      "First day",
    );
  });

  test("is empty when only the title or the source files are there", () => {
    expect(wikiDocumentExcerpt("# Only a title\n", "Only a title")).toBe("");
    expect(
      wikiDocumentExcerpt("<details>\n<summary>Relevant source files</summary>\n\n- `a.ts`\n</details>", "Only sources"),
    ).toBe("");
  });

  test("drops a source files disclosure cut off before its end", () => {
    expect(wikiDocumentExcerpt(GENERATED_PAGE.slice(0, 80), "Run admission")).toBe("");
  });

  test("clips a long line to 280 characters without splitting an emoji", () => {
    const excerpt = wikiDocumentExcerpt(`${"a".repeat(278)}😀😀😀`, "Title");
    expect(Array.from(excerpt)).toHaveLength(280);
    expect(excerpt).toBe(`${"a".repeat(278)}😀…`);
    expect(wikiDocumentExcerpt("short line", "Title")).toBe("short line");
  });
});
