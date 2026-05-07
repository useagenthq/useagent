import { beforeEach, describe, expect, test } from "bun:test";
import { clearPullsCache, listPulls } from "../src/github/pulls";
import { clearRepoCache } from "../src/github/repos";

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
  clearPullsCache();
}

describe("github pull listing — honest degradation", () => {
  beforeEach(clearGithubEnv);

  test("unconfigured → configured:false, empty, never throws", async () => {
    const listing = await listPulls();
    expect(listing.configured).toBe(false);
    expect(listing.pulls).toEqual([]);
    expect(listing.error).toBeUndefined();
    expect(listing.truncated).toBeUndefined();
  });
});
