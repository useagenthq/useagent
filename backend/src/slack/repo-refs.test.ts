import { describe, expect, test } from "bun:test";
import { githubRepoRefs, MAX_SLACK_REPO_REFS } from "./repo-refs";

describe("githubRepoRefs", () => {
  test("extracts owner/repo from a Slack-wrapped PR link", () => {
    expect(
      githubRepoRefs("test this pr now <https://github.com/upstream-org/backend/pull/19625> locally"),
    ).toEqual(["upstream-org/backend"]);
  });

  test("handles labeled links, bare urls, tree/blob/issues paths, and .git", () => {
    expect(githubRepoRefs("<https://github.com/a/b|a/b> and github.com/c/d.git")).toEqual([
      "a/b",
      "c/d",
    ]);
    expect(githubRepoRefs("see github.com/o/r/tree/main/src and github.com/o/r/issues/5")).toEqual([
      "o/r",
    ]);
  });

  test("dedupes case-insensitively, preserves order, and caps the count", () => {
    expect(githubRepoRefs("github.com/A/B github.com/a/b github.com/c/d")).toEqual(["A/B", "c/d"]);
    const many = Array.from({ length: 6 }, (_, i) => `github.com/o/r${i}`).join(" ");
    expect(githubRepoRefs(many)).toHaveLength(MAX_SLACK_REPO_REFS);
  });

  test("ignores reserved github.com paths and non-repo text", () => {
    expect(githubRepoRefs("browse github.com/features/copilot or github.com/orgs/x/people")).toEqual([]);
    expect(githubRepoRefs("no links here")).toEqual([]);
  });
});
