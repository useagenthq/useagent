import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearRepoCache,
  isKnownRepo,
  isValidRepoRef,
  listRepos,
  unknownRepos,
} from "../src/github/repos";

// Force the "unconfigured" env so these unit tests never touch the network.
// (The backend test env has no GITHUB_* keys; clear them defensively in case
// the ambient shell exports some.)
function clearGithubEnv(): void {
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT", "GITHUB_ORG", "GITHUB_OWNER"]) {
    delete process.env[k];
  }
  clearRepoCache();
}

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
    const listing = await listRepos();
    expect(listing.configured).toBe(false);
    expect(listing.repos).toEqual([]);
    expect(listing.error).toBeUndefined();
  });

  test("a repo can't be accepted when the feature is off", async () => {
    expect(await isKnownRepo("upstream-org/skynet")).toBe(false);
    // malformed refs are rejected before any lookup
    expect(await isKnownRepo("not-a-ref")).toBe(false);
  });

  test("unknownRepos: unconfigured → every ref is unknown; [] stays []", async () => {
    expect(await unknownRepos(["upstream-org/oats", "a/b"])).toEqual([
      "upstream-org/oats",
      "a/b",
    ]);
    expect(await unknownRepos([])).toEqual([]);
  });
});
