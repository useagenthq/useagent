import { describe, expect, test } from "bun:test";
import { plainTextPreview } from "./plain-text-preview";

describe("plainTextPreview", () => {
  test("strips literal HTML tags (the knowledge preview bug)", () => {
    const out = plainTextPreview("<details><summary>Overview</summary>Body text here</details>");
    expect(out).toBe("Overview Body text here");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });

  test("decodes then strips entity-escaped HTML", () => {
    const out = plainTextPreview("&lt;details&gt;&lt;summary&gt;Q&lt;/summary&gt;A&lt;/details&gt;");
    expect(out).toBe("Q A");
    expect(out).not.toContain("&lt;");
  });

  test("drops leading YAML frontmatter", () => {
    const out = plainTextPreview("---\ntitle: Foo\ntags: [a, b]\n---\nHello world");
    expect(out).toBe("Hello world");
  });

  test("removes markdown heading, emphasis, and inline-code syntax", () => {
    const out = plainTextPreview("# Heading\n\nSome **bold** and `code` here");
    expect(out).toBe("Heading Some bold and code here");
    expect(out).not.toContain("**");
    expect(out).not.toContain("`");
    expect(out).not.toContain("#");
  });

  test("keeps link and image label text, drops the URLs", () => {
    expect(plainTextPreview("See [the docs](https://example.com/x) now")).toBe("See the docs now");
    expect(plainTextPreview("![a diagram](img.png) caption")).toBe("a diagram caption");
  });

  test("leaves snake_case identifiers intact", () => {
    expect(plainTextPreview("Uses run_id and thread_id fields")).toBe("Uses run_id and thread_id fields");
  });

  test("collapses whitespace and returns empty for empty input", () => {
    expect(plainTextPreview("a\n\n\nb   c")).toBe("a b c");
    expect(plainTextPreview("")).toBe("");
  });

  test("caps length with an ellipsis", () => {
    const out = plainTextPreview("x ".repeat(400), 40);
    expect(out.length).toBeLessThanOrEqual(43);
    expect(out.endsWith("...")).toBe(true);
  });
});
