import { describe, expect, test } from "bun:test";
import { parseWikiStructure, WikiStructureError } from "../src/wiki-gen/structure";

// ---------------------------------------------------------------------------
// Pure parser for the LLM's XML wiki structure (ported from deepwiki-open).
// Proves the happy path, the comprehensive-sections path, the regex fallback on
// malformed XML (bare `&`, sloppy tags), fence stripping, importance
// normalization, and the hard failure when no <wiki_structure> block exists.
// ---------------------------------------------------------------------------

const CONCISE = `
<wiki_structure>
  <title>Demo Wiki</title>
  <description>A demo repository.</description>
  <pages>
    <page id="page-1">
      <title>Overview</title>
      <importance>high</importance>
      <relevant_files>
        <file_path>README.md</file_path>
        <file_path>src/index.ts</file_path>
      </relevant_files>
      <related_pages>
        <related>page-2</related>
      </related_pages>
    </page>
    <page id="page-2">
      <title>Utilities</title>
      <importance>bogus</importance>
      <relevant_files>
        <file_path>src/util.ts</file_path>
      </relevant_files>
    </page>
  </pages>
</wiki_structure>
`;

describe("parseWikiStructure", () => {
  test("parses a well-formed concise structure", () => {
    const s = parseWikiStructure(CONCISE, false);
    expect(s.title).toBe("Demo Wiki");
    expect(s.description).toBe("A demo repository.");
    expect(s.pages).toHaveLength(2);

    const [p1, p2] = s.pages;
    expect(p1!.id).toBe("page-1");
    expect(p1!.title).toBe("Overview");
    expect(p1!.importance).toBe("high");
    expect(p1!.filePaths).toEqual(["README.md", "src/index.ts"]);
    expect(p1!.relatedPages).toEqual(["page-2"]);
    // Unknown importance normalizes to "medium".
    expect(p2!.importance).toBe("medium");
    // Concise mode ignores sections.
    expect(s.sections).toHaveLength(0);
  });

  test("parses comprehensive sections when requested", () => {
    const xml = `
<wiki_structure>
  <title>T</title>
  <description>D</description>
  <sections>
    <section id="section-1">
      <title>Architecture</title>
      <pages><page_ref>page-1</page_ref></pages>
      <subsections><section_ref>section-2</section_ref></subsections>
    </section>
  </sections>
  <pages>
    <page id="page-1"><title>Overview</title><importance>high</importance>
      <relevant_files><file_path>a.ts</file_path></relevant_files>
    </page>
  </pages>
</wiki_structure>`;
    const s = parseWikiStructure(xml, true);
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0]!.title).toBe("Architecture");
    expect(s.sections[0]!.pages).toEqual(["page-1"]);
    expect(s.sections[0]!.subsections).toEqual(["section-2"]);
  });

  test("strips a ```xml code fence wrapper", () => {
    const s = parseWikiStructure("```xml\n" + CONCISE.trim() + "\n```", false);
    expect(s.pages).toHaveLength(2);
  });

  test("regex fallback survives malformed XML (bare & and sloppy tags)", () => {
    // A bare `&` and a missing closing tag would break a strict XML parser.
    const malformed = `
<wiki_structure>
  <title>Cats & Dogs</title>
  <description>Pets & more</description>
  <pages>
    <page id="page-1">
      <title>Data & Flow</title>
      <importance>high
      <relevant_files>
        <file_path>src/a.ts</file_path>
        <file_path>src/b.ts</file_path>
      </relevant_files>
    </page>
  </pages>
</wiki_structure>`;
    const s = parseWikiStructure(malformed, false);
    expect(s.title).toBe("Cats & Dogs");
    expect(s.pages).toHaveLength(1);
    expect(s.pages[0]!.title).toBe("Data & Flow");
    expect(s.pages[0]!.filePaths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("defaults a page id when the attribute is missing", () => {
    const xml = `<wiki_structure><title>T</title><description>D</description>
      <pages><page><title>No Id</title></page></pages></wiki_structure>`;
    const s = parseWikiStructure(xml, false);
    expect(s.pages[0]!.id).toBe("page-1");
  });

  test("recovers complete pages when the provider truncates only the root close", () => {
    const truncated = CONCISE.replace("</wiki_structure>", "");
    const s = parseWikiStructure(truncated, false);

    expect(s.title).toBe("Demo Wiki");
    expect(s.pages.map((page) => page.id)).toEqual(["page-1", "page-2"]);
  });

  test("throws when there is no <wiki_structure> block", () => {
    expect(() => parseWikiStructure("Sorry, I cannot help with that.", false)).toThrow(
      WikiStructureError,
    );
  });
});
