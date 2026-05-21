import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { gitRefTitle, repoShortname, runGitRefs, T3GitChips } from "./git-chip";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("runGitRefs (run row -> git identity)", () => {
  test("prefers repo_specs and carries the chosen branch", () => {
    expect(
      runGitRefs({
        repo: "acme/skynet",
        repos: ["acme/skynet", "acme/docs"],
        repo_specs: [
          { repo: "acme/skynet", branch: "feat/chips" },
          { repo: "acme/docs", branch: null },
        ],
      }),
    ).toEqual([
      { repo: "acme/skynet", branch: "feat/chips" },
      { repo: "acme/docs", branch: null },
    ]);
  });

  test("falls back to repos[] with no branch", () => {
    expect(runGitRefs({ repos: ["acme/skynet", "acme/docs"] })).toEqual([
      { repo: "acme/skynet", branch: null },
      { repo: "acme/docs", branch: null },
    ]);
  });

  test("falls back to the legacy single repo", () => {
    expect(runGitRefs({ repo: "acme/skynet" })).toEqual([
      { repo: "acme/skynet", branch: null },
    ]);
  });

  test("dedupes by repo, first entry wins", () => {
    expect(
      runGitRefs({
        repo_specs: [
          { repo: "acme/skynet", branch: "main" },
          { repo: "acme/skynet", branch: "feat/x" },
        ],
      }),
    ).toEqual([{ repo: "acme/skynet", branch: "main" }]);
  });

  test("skips malformed entries and empty branches", () => {
    expect(
      runGitRefs({
        repo_specs: [
          null,
          42,
          { repo: "" },
          { repo: 7, branch: "x" },
          { repo: "acme/skynet", branch: "" },
        ],
      }),
    ).toEqual([{ repo: "acme/skynet", branch: null }]);
  });

  test("a bare-workdir run yields nothing", () => {
    expect(runGitRefs({})).toEqual([]);
    expect(runGitRefs({ repo: null, repos: [], repo_specs: [] })).toEqual([]);
  });
});

describe("shortname + title", () => {
  test("shortname drops the owner", () => {
    expect(repoShortname("acme/skynet")).toBe("skynet");
    expect(repoShortname("bare-name")).toBe("bare-name");
  });

  test("title is the full ref in colon form", () => {
    expect(gitRefTitle({ repo: "acme/skynet", branch: "feat/x" })).toBe("acme/skynet:feat/x");
    expect(gitRefTitle({ repo: "acme/skynet", branch: null })).toBe("acme/skynet");
  });
});

describe("T3GitChips rendering", () => {
  test("renders a mono chip per repo with the full ref on title", () => {
    const html = renderToStaticMarkup(
      <T3GitChips
        refs={[
          { repo: "acme/skynet", branch: "feat/chips" },
          { repo: "acme/docs", branch: null },
        ]}
      />,
    );
    expect(html).toContain('data-t3-ui="git-chips"');
    expect(html).toContain('title="acme/skynet:feat/chips"');
    expect(html).toContain(">skynet:feat/chips<");
    expect(html).toContain('title="acme/docs"');
    expect(html).toContain(">docs<");
    expect(html).toContain("font-mono");
    expect(html).toContain("border-stroke-soft-200");
    expect(html).toContain("truncate");
  });

  test("renders nothing without refs", () => {
    expect(renderToStaticMarkup(<T3GitChips refs={[]} />)).toBe("");
  });

  test("keeps to mono-label tones with no color noise", () => {
    const html = renderToStaticMarkup(
      <T3GitChips refs={[{ repo: "acme/skynet", branch: null }]} />,
    );
    expect(html).toContain("text-text-soft-400");
    for (const loud of ["text-primary", "bg-blue", "text-blue", "text-success", "text-error"]) {
      expect(html).not.toContain(loud);
    }
  });
});

describe("wiring contract", () => {
  test("the thread row renders the git identity as a secondary line", () => {
    const row = read("./thread-row.tsx");
    expect(row).toContain("runGitRefs(run)");
    expect(row).toContain("<T3GitChips");
    expect(row).toContain("gitLine: gitRefs.length > 0");
  });

  test("the session bar renders the root run's repos", () => {
    const sessionView = read("../chat/session-view.tsx");
    expect(sessionView).toContain("<T3GitChips refs={runGitRefs(root)} />");
  });
});
