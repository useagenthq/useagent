import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearPullsCache, listPulls } from "../src/github/pulls";
import { clearRepoCache } from "../src/github/repos";

const githubEnvKeys = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
  "GITHUB_ORG",
  "GITHUB_OWNER",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_TENANT_ORG_ID",
  "SKYNET_PRIMARY_ORG_ID",
  "SLACK_DEFAULT_ORG_ID",
  "SKYNET_DEV_MODE",
  "ALLOW_DEV_ORG",
] as const;
const originalGithubEnv = new Map(
  githubEnvKeys.map((key) => [key, process.env[key]]),
);
const originalFetch = globalThis.fetch;

// Force the "unconfigured" env so these unit tests never touch the network
// (mirrors github-repos.test.ts — backend/.env carries App creds too).
function clearGithubEnv(): void {
  for (const k of githubEnvKeys) {
    delete process.env[k];
  }
  clearRepoCache();
  clearPullsCache();
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of githubEnvKeys) {
    const original = originalGithubEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  clearRepoCache();
  clearPullsCache();
});

describe("github pull listing — honest degradation", () => {
  beforeEach(clearGithubEnv);

  test("unconfigured → configured:false, empty, never throws", async () => {
    const listing = await listPulls("org-test");
    expect(listing.configured).toBe(false);
    expect(listing.pulls).toEqual([]);
    expect(listing.error).toBeUndefined();
    expect(listing.truncated).toBeUndefined();
  });

  test("rechecks tenant ownership before returning an org-cached pull listing", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_ORG = "upstream-org";
    process.env.GITHUB_TENANT_ORG_ID = "org-primary";
    let fetches = 0;
    globalThis.fetch = async (input) => {
      fetches += 1;
      const url = String(input);
      if (url.includes("/pulls?")) return new Response("[]", { status: 200 });
      return new Response(
        JSON.stringify([
          {
            full_name: "upstream-org/backend",
            name: "backend",
            private: true,
            default_branch: "main",
          },
        ]),
        { status: 200 },
      );
    };

    const allowed = await listPulls("org-primary");
    expect(allowed.error).toBeUndefined();
    expect(fetches).toBe(2);

    process.env.GITHUB_TENANT_ORG_ID = "org-other";
    const denied = await listPulls("org-primary");
    expect(denied.pulls).toEqual([]);
    expect(denied.error).toContain("not available to this organization");
    expect(fetches).toBe(2);
  });
});
