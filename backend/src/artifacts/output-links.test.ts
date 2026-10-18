import { describe, expect, test } from "bun:test";
import { explicitOutputLinks, replaceOutputLinks } from "./output-links";

const ROOT = "/work/project";

describe("output links", () => {
  test("uses the native GFM parse tree instead of code, escapes, or comments", () => {
    const markdown = [
      "    [indented](indented.txt)",
      "````md",
      "[fenced](fenced.txt)",
      "```",
      "[still fenced](also-fenced.txt)",
      "````",
      "`[inline](inline.txt)`",
      String.raw`\[escaped](escaped.txt)`,
      "<!-- [comment](comment.txt) -->",
      "[real](real.txt)",
    ].join("\n");

    expect(explicitOutputLinks(markdown, ROOT)).toEqual([
      { path: "/work/project/real.txt", image: false, href: "real.txt" },
    ]);
  });

  test("accepts native multiline, reference, nested-label, image, and angle destinations", () => {
    const markdown = [
      "[multiline](",
      "./reports/final.pdf",
      ")",
      "[nested **label**][result]",
      "![chart](<images/chart (final).png>)",
      "[percent](Q3100%.pdf)",
      "",
      "[result]: ../shared/output",
    ].join("\n");

    expect(explicitOutputLinks(markdown, ROOT)).toEqual([
      { path: "/work/project/reports/final.pdf", image: false, href: "./reports/final.pdf" },
      { path: "/work/shared/output", image: false, href: "../shared/output" },
      { path: "/work/project/images/chart (final).png", image: true, href: "images/chart (final).png" },
      { path: "/work/project/Q3100%.pdf", image: false, href: "Q3100%.pdf" },
    ]);
  });

  test("does not claim routes, remote URLs, protocol-relative URLs, anchors, or queries", () => {
    const markdown = [
      "[home](/)", "[download](/download)", "[tasks](/tasks/1)", "[wiki](/wiki)", "[app](/normalapp/page)",
      "[remote](https://example.com/%2F)", "[protocol](//example.com/a)",
      "[anchor](#part)", "[query](?page=2)", "[local](/var/output.txt)", "[invalid](/etc/passwd)",
    ].join("\n");
    expect(explicitOutputLinks(markdown, ROOT)).toEqual([
      { path: "/var/output.txt", image: false, href: "/var/output.txt" },
      { path: "/etc/passwd", image: false, href: "/etc/passwd" },
    ]);
  });

  test("leaves code citations with a line anchor alone; the file itself is still an output", () => {
    // Review agents cited repo lines like this and every finished run failed delivery.
    const markdown = [
      "[deploy](/root/work/org/repo/infra/deploy-app.sh:118)",
      "[guard](/root/work/org/repo/backend/src/db/single-backend.ts:17:3)",
      "[range](file:///root/work/org/repo/README.md#L10-L20)",
      "[anchor](<./src/index.ts#L5>)",
      "[report](/root/work/review.md)",
    ].join("\n");
    expect(explicitOutputLinks(markdown, ROOT)).toEqual([
      { path: "/root/work/review.md", image: false, href: "/root/work/review.md" },
    ]);
  });

  test("recognizes attached custom roots without treating the legacy root probe as the homepage", () => {
    expect(explicitOutputLinks("[home](/) [relative](output.any)", "/")).toEqual([
      { path: "/output.any", image: false, href: "output.any" },
    ]);
    expect(explicitOutputLinks("[custom](/provider/tenant/output.any)", "/provider/tenant")).toEqual([
      { path: "/provider/tenant/output.any", image: false, href: "/provider/tenant/output.any" },
    ]);
  });

  test("keeps explicit local failures visible to the publisher boundary", () => {
    expect(explicitOutputLinks("[x](file:///outside/a%20b.txt) [y](sandbox:/work/../secret) [p](file:///work/Q3100%.pdf) [s](sandbox:/work/R100%.csv)", ROOT)).toEqual([
      { path: "/outside/a b.txt", image: false, href: "file:///outside/a%20b.txt" },
      { path: "/work/../secret", image: false, href: "sandbox:/work/../secret" },
      { path: "/work/Q3100%.pdf", image: false, href: "file:///work/Q3100%.pdf" },
      { path: "/work/R100%.csv", image: false, href: "sandbox:/work/R100%.csv" },
    ]);
    expect(() => explicitOutputLinks("[x](file://host/path)", ROOT)).toThrow("invalid local output URL");
    expect(() => explicitOutputLinks("[x](sandbox:relative)", ROOT)).toThrow("invalid local output path");
  });

  test("uses download and preview URLs independently for the same href", () => {
    const markdown = "[download](same.png) ![preview](same.png)";
    const links = explicitOutputLinks(markdown, ROOT);
    const rewritten = replaceOutputLinks(markdown, links, new Map([
      ["/work/project/same.png", { preview: "/preview/same", download: "/download/same" }],
    ]));
    expect(Bun.markdown.html(rewritten)).toContain('href="/download/same"');
    expect(Bun.markdown.html(rewritten)).toContain('src="/preview/same"');
  });

  test("rewrites parsed links and images while preserving rendered structure", () => {
    const markdown = [
      "# Result", "", "- [Report **now**][r]", "- ![Chart](<images/chart (1).png>)", "",
      "> Keep *this*", "", "| A | B |", "| :- | -: |", "| `x` | ~~y~~ |", "",
      "~~~txt", "[not output](inside-code.txt)", "~~~", "", "<!-- keep comment -->",
      "[r]: <./final report.pdf>", "",
    ].join("\n");
    const links = explicitOutputLinks(markdown, ROOT);
    const rewritten = replaceOutputLinks(markdown, links, new Map([
      ["/work/project/final report.pdf", { preview: "/preview/report", download: "/download/report" }],
      ["/work/project/images/chart (1).png", { preview: "/preview/chart", download: "/download/chart" }],
    ]));

    expect(Bun.markdown.html(rewritten)).toContain('href="/download/report"');
    expect(Bun.markdown.html(rewritten)).toContain('src="/preview/chart"');
    expect(Bun.markdown.html(rewritten).replace("/download/report", "./final%20report.pdf").replace("/preview/chart", "images/chart%20(1).png"))
      .toBe(Bun.markdown.html(markdown));
  });

  test("returns the original bytes when no destination changes", () => {
    const markdown = "[x](./x.txt)  \n";
    const links = explicitOutputLinks(markdown, ROOT);
    expect(replaceOutputLinks(markdown, links, new Map([
      [links[0]!.path, { preview: "./x.txt", download: "./x.txt" }],
    ]))).toBe(markdown);
  });

  test("bounds malformed input and actual output occurrences", () => {
    expect(() => explicitOutputLinks("[".repeat(32 * 1024), ROOT)).toThrow("output Markdown is too complex");
    const markdown = Array.from({ length: 101 }, (_, index) => `[${index}](./${index}.txt)`).join("\n");
    expect(() => explicitOutputLinks(markdown, ROOT)).toThrow("too many output links");
    expect(() => explicitOutputLinks("x".repeat(256 * 1024 + 1), ROOT)).toThrow("output Markdown is too large");
  });
});
