import { describe, expect, test } from "bun:test";
import { formatRepoRef, parseRepoRef } from "../src/github/repo-ref";

describe("repo-ref branch encoding", () => {
  test("a bare repo means the default branch", () => {
    expect(formatRepoRef("acme/api", null)).toBe("acme/api");
    expect(formatRepoRef("acme/api", undefined)).toBe("acme/api");
    expect(formatRepoRef("acme/api", "")).toBe("acme/api");
    expect(formatRepoRef("acme/api", "   ")).toBe("acme/api");
    expect(parseRepoRef("acme/api")).toEqual({ repo: "acme/api", branch: null });
  });

  test("a chosen branch is suffixed with ':'", () => {
    expect(formatRepoRef("acme/api", "main")).toBe("acme/api:main");
    expect(parseRepoRef("acme/api:main")).toEqual({ repo: "acme/api", branch: "main" });
  });

  test("a branch may itself contain '/' — split is on the FIRST colon only", () => {
    const encoded = formatRepoRef("acme/api", "feat/rate-limiting");
    expect(encoded).toBe("acme/api:feat/rate-limiting");
    expect(parseRepoRef(encoded)).toEqual({
      repo: "acme/api",
      branch: "feat/rate-limiting",
    });
  });

  test("round-trips for realistic repo + branch shapes", () => {
    const cases: Array<{ repo: string; branch: string | null }> = [
      { repo: "upstream-org/skynet", branch: null },
      { repo: "upstream-org/skynet", branch: "master" },
      { repo: "a.b_c-d/e.f_g-h", branch: "release/v1.2.3" },
      { repo: "owner/name", branch: "chore/next-16-1" },
    ];
    for (const c of cases) {
      expect(parseRepoRef(formatRepoRef(c.repo, c.branch))).toEqual(c);
    }
  });

  test("blank branch tail decodes to the default branch", () => {
    // "owner/name:" (trailing colon, empty branch) is treated as no branch.
    expect(parseRepoRef("acme/api:")).toEqual({ repo: "acme/api", branch: null });
  });
});
