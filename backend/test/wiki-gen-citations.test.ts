import { describe, expect, test } from "bun:test";
import {
  generateFileUrl,
  postProcessWikiContent,
  type RepoUrlContext,
} from "../src/wiki-gen/citations";

// ---------------------------------------------------------------------------
// Pure citation/link post-processor (ported from deepwiki-open). Proves the
// model's empty-parenthesis citation forms resolve to real repo blob links, the
// <details> source block is rebuilt from the known file list, `Sources:`-prefix
// and bare-filename forms resolve, stray parens are cleaned, and a local repo
// leaves paths bare.
// ---------------------------------------------------------------------------

const GH: RepoUrlContext = {
  type: "github",
  repoUrl: "https://github.com/acme/demo",
  defaultBranch: "main",
};
const FILES = ["src/index.ts", "src/util.ts"];

describe("generateFileUrl", () => {
  test("builds a github blob URL", () => {
    expect(generateFileUrl("src/index.ts", GH)).toBe(
      "https://github.com/acme/demo/blob/main/src/index.ts",
    );
  });
  test("leaves the bare path for a local repo", () => {
    expect(generateFileUrl("src/index.ts", { type: "local", repoUrl: null, defaultBranch: "main" })).toBe(
      "src/index.ts",
    );
  });
});

describe("postProcessWikiContent", () => {
  test("resolves a known-file line-range citation to a github blob link with anchor", () => {
    const out = postProcessWikiContent("Body.\n\nSources: [src/index.ts:10-20]()", FILES, GH);
    expect(out).toContain(
      "Sources: [src/index.ts:10-20](https://github.com/acme/demo/blob/main/src/index.ts#L10-L20)",
    );
  });

  test("resolves a whole-file citation (no line numbers)", () => {
    const out = postProcessWikiContent("Sources: [src/util.ts]()", FILES, GH);
    expect(out).toContain(
      "Sources: [src/util.ts](https://github.com/acme/demo/blob/main/src/util.ts)",
    );
  });

  test("rebuilds the <details> source block from the known file list", () => {
    const out = postProcessWikiContent("# Title\n\nText.", FILES, GH);
    expect(out).toContain("<summary>Relevant source files</summary>");
    expect(out).toContain("- [src/index.ts](https://github.com/acme/demo/blob/main/src/index.ts)");
    expect(out).toContain("- [src/util.ts](https://github.com/acme/demo/blob/main/src/util.ts)");
  });

  test("replaces an existing <details> block rather than duplicating it", () => {
    const stale =
      "<details>\n<summary>Relevant source files</summary>\n\nold\n</details>\n\n# T";
    const out = postProcessWikiContent(stale, FILES, GH);
    expect(out.match(/<summary>Relevant source files<\/summary>/g)).toHaveLength(1);
    expect(out).not.toContain("old");
  });

  test("resolves a [Sources: barename:line]() prefix form via basename lookup", () => {
    const out = postProcessWikiContent("See [Sources: util.ts:5]()", FILES, GH);
    expect(out).toContain(
      "Sources: [src/util.ts:5](https://github.com/acme/demo/blob/main/src/util.ts#L5)",
    );
  });

  test("resolves a generic file-looking empty citation not in the known list", () => {
    const out = postProcessWikiContent("Ref [docs/other.py:3]()", [], GH);
    expect(out).toContain("[docs/other.py:3](https://github.com/acme/demo/blob/main/docs/other.py#L3)");
  });

  test("strips a redundant empty () after a completed link", () => {
    const out = postProcessWikiContent("[label](https://x/y)()", [], GH);
    expect(out).toContain("[label](https://x/y)");
    expect(out).not.toContain(")()");
  });

  test("leaves citations bare for a local repo (no web URL)", () => {
    const local: RepoUrlContext = { type: "local", repoUrl: null, defaultBranch: "main" };
    const out = postProcessWikiContent("Sources: [src/index.ts:1]()", FILES, local);
    // Unresolvable -> the empty-() marker is left as-is.
    expect(out).toContain("Sources: [src/index.ts:1]()");
  });
});
