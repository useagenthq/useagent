import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WikiContent } from "./wiki-content";
import { wikiContentPreview } from "./wiki-content-data";

const WIKI_WITH_SOURCE_DISCLOSURE = [
  "# Run admission",
  "",
  "The run gate keeps org-scoped sessions bounded.",
  "",
  "<details>",
  "<summary>Relevant source files</summary>",
  "",
  "- `backend/src/runs/run-admission.ts`",
  "- `backend/test/run-admission.test.ts`",
  "",
  "</details>",
].join("\n");

test("wiki content renders generated source files disclosure as native details", () => {
  const html = renderToStaticMarkup(<WikiContent content={WIKI_WITH_SOURCE_DISCLOSURE} />);

  expect(html).toContain("<details");
  expect(html).toContain("<summary");
  expect(html).toContain("Relevant source files");
  expect(html).toContain("run-admission.ts");
  expect(html).not.toContain("&lt;details&gt;");
  expect(html).not.toContain("&lt;summary&gt;");
});

test("wiki content keeps unrecognized raw html escaped", () => {
  const html = renderToStaticMarkup(
    <WikiContent content={"<details><summary>Unsafe</summary><script>alert(1)</script></details>"} />,
  );

  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;details&gt;");
});

test("wiki previews ignore generated source files disclosure", () => {
  expect(wikiContentPreview(WIKI_WITH_SOURCE_DISCLOSURE, "Run admission")).toBe(
    "The run gate keeps org-scoped sessions bounded.",
  );
  expect(
    wikiContentPreview(
      "<details>\n<summary>Relevant source files</summary>\n\n- `a.ts`\n</details>",
      "Only sources",
    ),
  ).toBe("");
});
