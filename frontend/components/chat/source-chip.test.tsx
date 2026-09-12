import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceChip } from "./source-chip";

describe("SourceChip", () => {
  test("preserves source link behavior and its accessible label", () => {
    const html = renderToStaticMarkup(
      <SourceChip domain="docs.example.com" href="https://docs.example.com/guide" />,
    );
    expect(html).toContain('href="https://docs.example.com/guide"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('aria-label="Open source: docs.example.com"');
    expect(html).toContain('data-testid="source-chip"');
    expect(html).toContain("docs.example.com");
  });

  test("a source without a URL remains labelled text rather than a link", () => {
    const html = renderToStaticMarkup(<SourceChip domain="local.test" />);
    expect(html).not.toContain("<a");
    expect(html).toContain('data-testid="source-chip"');
    expect(html).toContain("local.test");
  });
});
