import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown";

describe("Markdown links", () => {
  test("renders downloadable artifacts as compact typed chips", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"[Download report](/api/artifacts/report.pdf)"}</Markdown>,
    );

    expect(html).toContain('href="/api/artifacts/report.pdf"');
    expect(html).toContain("Download report");
    expect(html).toContain(">PDF<");
    expect(html).toContain("rounded-full");
  });

  test("keeps ordinary links on the plain markdown link path", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"[Documentation](https://useagent.org/docs/)"}</Markdown>,
    );

    expect(html).toContain('href="https://useagent.org/docs/"');
    expect(html).not.toContain("rounded-full");
  });
});
