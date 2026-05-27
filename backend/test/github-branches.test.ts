import { beforeEach, describe, expect, test } from "bun:test";
import { clearRepoCache, listBranches } from "../src/github/repos";

// Force the "unconfigured" env so these unit tests never touch the network
// (mirrors github-repos.test.ts — backend/.env carries App creds too).
function clearGithubEnv(): void {
  for (const k of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_PAT",
    "GITHUB_ORG",
    "GITHUB_OWNER",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
  ]) {
    delete process.env[k];
  }
  clearRepoCache();
}

describe("github branch listing — honest degradation", () => {
  beforeEach(clearGithubEnv);

  test("unconfigured → configured:false, empty, never throws", async () => {
    const listing = await listBranches("upstream-org/skynet", "org-test");
    expect(listing.configured).toBe(false);
    expect(listing.branches).toEqual([]);
    expect(listing.error).toBeUndefined();
  });

  test("a malformed ref is reported, not proxied", async () => {
    const listing = await listBranches("not-a-ref", "org-test");
    // unconfigured short-circuits first (feature off), so still configured:false.
    expect(listing.configured).toBe(false);
    expect(listing.branches).toEqual([]);
  });
});
