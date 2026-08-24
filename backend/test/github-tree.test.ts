import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearRepoCache,
  listRepoTree,
  sanitizeTreePath,
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
const originalFetch = globalThis.fetch;

// Force the "unconfigured" env so these unit tests never touch the network
// (mirrors github-repos.test.ts — backend/.env carries App creds too).
function clearGithubEnv(): void {
  for (const k of githubEnvKeys) {
    delete process.env[k];
  }
  clearRepoCache();
}

/** Configure a single-tenant PAT deployment so listRepos resolves an owner and
 *  offers exactly `repos`; the mock branches the repos listing vs the tree call. */
function configureTenant(repos: unknown[], dir: unknown): () => number {
  process.env.GITHUB_TOKEN = "test-token";
  process.env.GITHUB_ORG = "upstream-org";
  process.env.GITHUB_TENANT_ORG_ID = "org-primary";
  let fetches = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetches += 1;
    const url = String(input);
    if (url.includes("/contents/")) {
      return new Response(JSON.stringify(dir), { status: 200 });
    }
    return new Response(JSON.stringify(repos), { status: 200 });
  }) as typeof fetch;
  return () => fetches;
}

const BACKEND_REPO = {
  full_name: "upstream-org/backend",
  name: "backend",
  private: true,
  default_branch: "main",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of githubEnvKeys) {
    const original = originalGithubEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  clearRepoCache();
});

describe("sanitizeTreePath", () => {
  test("normalizes empty / root / slash-wrapped paths", () => {
    expect(sanitizeTreePath(null)).toBe("");
    expect(sanitizeTreePath(undefined)).toBe("");
    expect(sanitizeTreePath("")).toBe("");
    expect(sanitizeTreePath("   ")).toBe("");
    expect(sanitizeTreePath("/src/")).toBe("src");
    expect(sanitizeTreePath("src/lib")).toBe("src/lib");
  });

  test("rejects traversal, dot segments, and absurd depth/length", () => {
    for (const bad of ["..", "../etc", "a/../b", ".", "src/./x", "a//b"]) {
      expect(sanitizeTreePath(bad)).toBeNull();
    }
    expect(sanitizeTreePath("a".repeat(1100))).toBeNull();
    expect(sanitizeTreePath(Array.from({ length: 41 }, () => "d").join("/"))).toBeNull();
  });
});

describe("github tree listing — honest degradation", () => {
  beforeEach(clearGithubEnv);

  test("unconfigured → configured:false, empty, never throws", async () => {
    const listing = await listRepoTree("upstream-org/backend", "org-test", {});
    expect(listing.configured).toBe(false);
    expect(listing.entries).toEqual([]);
    expect(listing.error).toBeUndefined();
  });

  test("a traversal path is refused before any GitHub call", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const listing = await listRepoTree("upstream-org/backend", "org-primary", {
      path: "../secrets",
    });
    expect(listing.error).toBe("invalid path");
    expect(listing.entries).toEqual([]);
    expect(fetches).toBe(0);
  });

  test("a malformed ref is refused before any GitHub call", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const listing = await listRepoTree("upstream-org/backend", "org-primary", {
      ref: "bad ref",
    });
    expect(listing.error).toBe("invalid ref");
    expect(fetches).toBe(0);
  });
});

describe("github tree listing — scoped to offered repos", () => {
  beforeEach(clearGithubEnv);

  test("lists one directory level, dirs first, then name-sorted files", async () => {
    const getFetches = configureTenant(
      [BACKEND_REPO],
      [
        { path: "src/z.ts", type: "file" },
        { path: "src/lib", type: "dir" },
        { path: "src/a.ts", type: "file" },
        { path: "src/components", type: "dir" },
      ],
    );

    const listing = await listRepoTree("upstream-org/backend", "org-primary", {
      path: "src",
    });
    expect(listing.configured).toBe(true);
    expect(listing.path).toBe("src");
    expect(listing.error).toBeUndefined();
    expect(listing.entries).toEqual([
      { path: "src/components", type: "dir" },
      { path: "src/lib", type: "dir" },
      { path: "src/a.ts", type: "file" },
      { path: "src/z.ts", type: "file" },
    ]);
    // One repos listing + one contents call.
    expect(getFetches()).toBe(2);
  });

  test("an unknown repo is refused without a tree fetch", async () => {
    const getFetches = configureTenant([BACKEND_REPO], []);
    const listing = await listRepoTree("upstream-org/secret", "org-primary", {});
    expect(listing.entries).toEqual([]);
    expect(listing.error).toBe("repository not available");
    // Only the repos listing ran; the tree endpoint was never hit.
    expect(getFetches()).toBe(1);
  });

  test("another product org is denied before touching the tree", async () => {
    const getFetches = configureTenant([BACKEND_REPO], []);
    const listing = await listRepoTree("upstream-org/backend", "org-other", {});
    expect(listing.entries).toEqual([]);
    expect(listing.error).toContain("not available to this organization");
    expect(getFetches()).toBe(0);
  });

  test("caps the level and reports truncation", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      path: `src/file-${String(i).padStart(3, "0")}.ts`,
      type: "file",
    }));
    configureTenant([BACKEND_REPO], many);
    const listing = await listRepoTree("upstream-org/backend", "org-primary", {
      path: "src",
    });
    expect(listing.entries).toHaveLength(200);
    expect(listing.truncated).toBe(true);
  });

  test("a file path (object response) yields an honest empty level", async () => {
    configureTenant([BACKEND_REPO], { path: "src/index.ts", type: "file" });
    const listing = await listRepoTree("upstream-org/backend", "org-primary", {
      path: "src/index.ts",
    });
    expect(listing.entries).toEqual([]);
    expect(listing.error).toBeUndefined();
  });

  test("a failed GitHub fetch degrades to an honest error", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_ORG = "upstream-org";
    process.env.GITHUB_TENANT_ORG_ID = "org-primary";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/contents/")) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify([BACKEND_REPO]), { status: 200 });
    }) as typeof fetch;
    const listing = await listRepoTree("upstream-org/backend", "org-primary", {
      path: "src",
    });
    expect(listing.configured).toBe(true);
    expect(listing.entries).toEqual([]);
    expect(listing.error).toContain("GitHub API 500");
  });
});
