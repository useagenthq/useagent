import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { gitRefTitle, repoShortname, runGitRefs, GitChips } from "./git-chip";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("runGitRefs (run row -> git identity)", () => {
  test("prefers repo_specs and carries the chosen branch", () => {
    expect(
      runGitRefs({
        repo: "acme/useagent",
        repos: ["acme/useagent", "acme/docs"],
        repo_specs: [
          { repo: "acme/useagent", branch: "feat/chips" },
          { repo: "acme/docs", branch: null },
        ],
      }),
    ).toEqual([
      { repo: "acme/useagent", branch: "feat/chips" },
      { repo: "acme/docs", branch: null },
    ]);
  });

  test("falls back to repos[] with no branch", () => {
    expect(runGitRefs({ repos: ["acme/useagent", "acme/docs"] })).toEqual([
      { repo: "acme/useagent", branch: null },
      { repo: "acme/docs", branch: null },
    ]);
  });

  test("falls back to the legacy single repo", () => {
    expect(runGitRefs({ repo: "acme/useagent" })).toEqual([
      { repo: "acme/useagent", branch: null },
    ]);
  });

  test("dedupes by repo, first entry wins", () => {
    expect(
      runGitRefs({
        repo_specs: [
          { repo: "acme/useagent", branch: "main" },
          { repo: "acme/useagent", branch: "feat/x" },
        ],
      }),
    ).toEqual([{ repo: "acme/useagent", branch: "main" }]);
  });

  test("skips malformed entries and empty branches", () => {
    expect(
      runGitRefs({
        repo_specs: [
          null,
          42,
          { repo: "" },
          { repo: 7, branch: "x" },
          { repo: "acme/useagent", branch: "" },
        ],
      }),
    ).toEqual([{ repo: "acme/useagent", branch: null }]);
  });

  test("a bare-workdir run yields nothing", () => {
    expect(runGitRefs({})).toEqual([]);
    expect(runGitRefs({ repo: null, repos: [], repo_specs: [] })).toEqual([]);
  });
});

describe("shortname + title", () => {
  test("shortname drops the owner", () => {
    expect(repoShortname("acme/useagent")).toBe("useagent");
    expect(repoShortname("bare-name")).toBe("bare-name");
  });

  test("title is the full ref in colon form", () => {
    expect(gitRefTitle({ repo: "acme/useagent", branch: "feat/x" })).toBe("acme/useagent:feat/x");
    expect(gitRefTitle({ repo: "acme/useagent", branch: null })).toBe("acme/useagent");
  });
});

describe("GitChips rendering", () => {
  test("renders a mono chip per repo with the full ref on title", () => {
    const html = renderToStaticMarkup(
      <GitChips
        refs={[
          { repo: "acme/useagent", branch: "feat/chips" },
          { repo: "acme/docs", branch: null },
        ]}
      />,
    );
    expect(html).toContain('data-session-ui="git-chips"');
    expect(html).toContain('title="acme/useagent:feat/chips"');
    expect(html).toContain(">useagent:feat/chips<");
    expect(html).toContain('title="acme/docs"');
    expect(html).toContain(">docs<");
    expect(html).toContain("font-mono");
    expect(html).toContain("border-border-button-default");
    expect(html).toContain("truncate");
  });

  test("renders nothing without refs", () => {
    expect(renderToStaticMarkup(<GitChips refs={[]} />)).toBe("");
  });

  test("keeps to mono-label tones with no color noise", () => {
    const html = renderToStaticMarkup(
      <GitChips refs={[{ repo: "acme/useagent", branch: null }]} />,
    );
    expect(html).toContain("text-text-tertiary");
    for (const loud of ["text-primary", "bg-blue", "text-blue", "text-success", "text-error"]) {
      expect(html).not.toContain(loud);
    }
  });
});

describe("wiring contract", () => {
  test("the thread row renders the git identity as a secondary line", () => {
    const row = read("./thread-row.tsx");
    expect(row).toContain("runGitRefs(run)");
    expect(row).toContain("<GitChips");
    expect(row).toContain("gitLine: gitRefs.length > 0");
  });

  test("the session bar renders the root run's repos", () => {
    const sessionView = read("../chat/session-view.tsx");
    expect(sessionView).toContain("<GitChips refs={runGitRefs(root)} />");
  });
});
