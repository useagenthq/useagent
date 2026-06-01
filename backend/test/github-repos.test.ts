import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearRepoCache,
  githubOrgAccessError,
  isKnownRepo,
  isValidRepoRef,
  listRepos,
  unknownRepos,
} from "../src/github/repos";

const githubEnvKeys = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
  "GITHUB_ORG",
  "GITHUB_OWNER",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_TENANT_ORG_ID",
  "USEAGENT_PRIMARY_ORG_ID",
  "SLACK_DEFAULT_ORG_ID",
  "USEAGENT_DEV_MODE",
  "ALLOW_DEV_ORG",
] as const;
const originalGithubEnv = new Map(
  githubEnvKeys.map((key) => [key, process.env[key]]),
);

// Force the "unconfigured" env so these unit tests never touch the network.
// backend/.env now carries the GitHub App creds, so clear those too (not just
// the PAT/owner keys) — otherwise `configured` would be true here.
function clearGithubEnv(): void {
  for (const k of githubEnvKeys) {
    delete process.env[k];
  }
  clearRepoCache();
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of githubEnvKeys) {
    const original = originalGithubEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  clearRepoCache();
});

describe("github repo ref validation", () => {
  test("accepts owner/name", () => {
    expect(isValidRepoRef("upstream-org/skynet")).toBe(true);
    expect(isValidRepoRef("a.b_c-d/e.f_g-h")).toBe(true);
  });

  test("rejects malformed refs", () => {
    for (const bad of ["", "noslash", "a/b/c", "a b/c", "owner/", "/name", "a/b;rm"]) {
      expect(isValidRepoRef(bad)).toBe(false);
    }
  });
});

describe("github listing — unconfigured is a graceful no-op", () => {
  beforeEach(clearGithubEnv);

  test("no token and no owner → configured:false, empty, never throws", async () => {
    const listing = await listRepos("org-test");
    expect(listing.configured).toBe(false);
    expect(listing.repos).toEqual([]);
    expect(listing.error).toBeUndefined();
  });

  test("a repo can't be accepted when the feature is off", async () => {
    expect(await isKnownRepo("upstream-org/skynet", "org-test")).toBe(false);
    // malformed refs are rejected before any lookup
    expect(await isKnownRepo("not-a-ref", "org-test")).toBe(false);
  });

  test("unknownRepos: unconfigured → every ref is unknown; [] stays []", async () => {
    expect(await unknownRepos(["upstream-org/oats", "a/b"], "org-test")).toEqual([
      "upstream-org/oats",
      "a/b",
    ]);
    expect(await unknownRepos([], "org-test")).toEqual([]);
  });
});

describe("github listing — one product organization owns the shared credential", () => {
  beforeEach(clearGithubEnv);

  test("rejects another product org before touching GitHub or the shared cache", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_ORG = "upstream-org";
    process.env.GITHUB_TENANT_ORG_ID = "org-primary";
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify([
        {
          id: 123456,
          full_name: "upstream-org/backend",
          name: "backend",
          private: true,
          default_branch: "main",
        },
      ]), { status: 200 });
    };

    expect(githubOrgAccessError("org-other")).toContain(
      "not available to this organization",
    );
    const denied = await listRepos("org-other");
    expect(denied.repos).toEqual([]);
    expect(denied.error).toContain("not available to this organization");
    expect(fetches).toBe(0);

    const allowed = await listRepos("org-primary");
    expect(allowed.repos.map((repo) => repo.full_name)).toEqual([
      "upstream-org/backend",
    ]);
    expect(allowed.repos[0]).toEqual({
      full_name: "upstream-org/backend",
      name: "backend",
      private: true,
      default_branch: "main",
    });
    expect(JSON.stringify(allowed)).not.toContain("123456");
    expect(fetches).toBe(1);
  });

  test("fails closed with an actionable error when production has no tenant binding", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_ORG = "upstream-org";
    process.env.USEAGENT_DEV_MODE = "false";
    process.env.ALLOW_DEV_ORG = "0";
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response("[]", { status: 200 });
    };

    const listing = await listRepos("org-primary");
    expect(listing.repos).toEqual([]);
    expect(listing.error).toContain("GITHUB_TENANT_ORG_ID");
    expect(fetches).toBe(0);
  });

  test("keeps the current single-tenant deployment compatible via its Slack org binding", () => {
    process.env.SLACK_DEFAULT_ORG_ID = "org-current";
    expect(githubOrgAccessError("org-current")).toBeNull();
    expect(githubOrgAccessError("org-other")).toContain(
      "not available to this organization",
    );
  });
});
