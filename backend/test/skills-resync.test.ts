import { beforeEach, describe, expect, test } from "bun:test";
import { DEV_ORG_ID } from "../src/seed";
import type { GithubRepositoryAccess } from "../src/github/auth";
import {
  clearResyncStateForTest,
  runSkillsResyncSweep,
  skillsResyncConfig,
  type SkillsResyncDeps,
} from "../src/skills/resync";

// ---------------------------------------------------------------------------
// Periodic skill-resync orchestration, unit-tested with injected fakes (repo
// lister / head resolver / scanner / importer) — zero GitHub, zero DB. The
// source-keyed upsert's idempotency is covered end-to-end by
// skill-import.test.ts; here we prove the SWEEP: disabled-by-default config,
// serial pacing, per-sweep bounds, per-repo error isolation, the unchanged-HEAD
// short-circuit, and honest summary tallies.
// ---------------------------------------------------------------------------

const ORG = "org-resync-test";
const ACCESS: GithubRepositoryAccess = {
  orgId: ORG,
  token: "tenant-token",
  owner: "acme",
  source: "app",
  connectionId: "connection-1",
};

interface FakeRepo {
  name: string;
  head: string;
  /** SKILL.md candidate paths the scan reports (default none). */
  candidates?: string[];
  /** Per-path import action (default "created"). */
  actions?: Record<string, "created" | "updated" | "unchanged" | "skipped">;
  /** Make this repo's scan / head resolution throw. */
  failScan?: boolean;
  failHead?: boolean;
}

interface Calls {
  openedOrgs: string[];
  listedOrgs: string[];
  sleeps: number[];
  headChecks: string[];
  scans: string[];
  imports: { repo: string; paths: string[] }[];
}

function fakeDeps(
  repos: FakeRepo[],
  overrides: Partial<SkillsResyncDeps> = {},
): { deps: SkillsResyncDeps; calls: Calls } {
  const calls: Calls = {
    openedOrgs: [],
    listedOrgs: [],
    sleeps: [],
    headChecks: [],
    scans: [],
    imports: [],
  };
  const byName = new Map(repos.map((r) => [r.name, r]));
  const deps: SkillsResyncDeps = {
    openAccess: async (orgId) => {
      calls.openedOrgs.push(orgId);
      return { ...ACCESS, orgId };
    },
    listRepos: async (access) => {
      calls.listedOrgs.push(access.orgId);
      return {
        configured: true,
        repos: repos.map((r) => ({ full_name: r.name })),
      };
    },
    resolveHeadSha: async (repo, access) => {
      expect(access.token).toBe(ACCESS.token);
      calls.headChecks.push(repo);
      const r = byName.get(repo)!;
      if (r.failHead) throw new Error(`ls-remote failed for ${repo}`);
      return r.head;
    },
    scan: async (_orgId, repo, access) => {
      expect(access.token).toBe(ACCESS.token);
      calls.scans.push(repo);
      const r = byName.get(repo)!;
      if (r.failScan) throw new Error(`clone failed for ${repo}`);
      return { sha: r.head, candidates: (r.candidates ?? []).map((path) => ({ path })) };
    },
    importPaths: async (_orgId, repo, paths, access) => {
      expect(access.token).toBe(ACCESS.token);
      calls.imports.push({ repo, paths });
      const r = byName.get(repo)!;
      return {
        results: paths.map((path) => ({ path, action: r.actions?.[path] ?? "created" })),
      };
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
    maxReposPerSweep: 200,
    repoPacingMs: 2_000,
    ...overrides,
  };
  return { deps, calls };
}

beforeEach(() => {
  clearResyncStateForTest();
  delete process.env.SKILLS_RESYNC_INTERVAL_MIN;
  delete process.env.SKILLS_RESYNC_ORG_ID;
});

describe("skillsResyncConfig", () => {
  test("disabled by default: unset / 0 / garbage all resolve to null", () => {
    expect(skillsResyncConfig({})).toBeNull();
    expect(skillsResyncConfig({ SKILLS_RESYNC_INTERVAL_MIN: "0" })).toBeNull();
    expect(skillsResyncConfig({ SKILLS_RESYNC_INTERVAL_MIN: "-5" })).toBeNull();
    expect(skillsResyncConfig({ SKILLS_RESYNC_INTERVAL_MIN: "soon" })).toBeNull();
  });

  test("a positive interval enables; org defaults to the dev org, override wins", () => {
    expect(skillsResyncConfig({ SKILLS_RESYNC_INTERVAL_MIN: "30" })).toEqual({
      intervalMin: 30,
      orgId: DEV_ORG_ID,
    });
    expect(
      skillsResyncConfig({
        SKILLS_RESYNC_INTERVAL_MIN: "60",
        SKILLS_RESYNC_ORG_ID: "org-prod",
      }),
    ).toEqual({ intervalMin: 60, orgId: "org-prod" });
  });
});

describe("runSkillsResyncSweep", () => {
  test("fails closed before listing or per-repo work when tenant access is unavailable", async () => {
    const { deps, calls } = fakeDeps([{ name: "o/private", head: "sha-1" }], {
      openAccess: async () => {
        throw new Error("GitHub integration has been revoked for this organization");
      },
    });
    const summary = await runSkillsResyncSweep(ORG, deps);
    expect(summary.reposListed).toBe(0);
    expect(calls.listedOrgs).toEqual([]);
    expect(calls.headChecks).toEqual([]);
    expect(calls.scans).toEqual([]);
  });

  test("imports every candidate serially and tallies per-action counts", async () => {
    const { deps, calls } = fakeDeps([
      {
        name: "acme/tools",
        head: "sha-a",
        candidates: ["a/SKILL.md", "b/SKILL.md"],
        actions: { "a/SKILL.md": "created", "b/SKILL.md": "unchanged" },
      },
      {
        name: "acme/infra",
        head: "sha-b",
        candidates: ["c/SKILL.md", "d/SKILL.md"],
        actions: { "c/SKILL.md": "updated", "d/SKILL.md": "skipped" },
      },
    ]);
    const summary = await runSkillsResyncSweep(ORG, deps);
    expect(summary).toEqual({
      reposListed: 2,
      reposScanned: 2,
      reposUnchangedHead: 0,
      reposFailed: 0,
      created: 1,
      updated: 1,
      unchanged: 1,
      skippedPaths: 1,
    });
    expect(calls.scans).toEqual(["acme/tools", "acme/infra"]);
    expect(calls.listedOrgs).toEqual([ORG]);
    expect(calls.openedOrgs).toEqual([ORG]);
    expect(calls.imports).toEqual([
      { repo: "acme/tools", paths: ["a/SKILL.md", "b/SKILL.md"] },
      { repo: "acme/infra", paths: ["c/SKILL.md", "d/SKILL.md"] },
    ]);
  });

  test("paces BETWEEN repos: n-1 sleeps of repoPacingMs, none before the first", async () => {
    const { deps, calls } = fakeDeps(
      [
        { name: "o/r1", head: "s1" },
        { name: "o/r2", head: "s2" },
        { name: "o/r3", head: "s3" },
      ],
      { repoPacingMs: 250 },
    );
    await runSkillsResyncSweep(ORG, deps);
    expect(calls.sleeps).toEqual([250, 250]);
  });

  test("bounds a sweep to maxReposPerSweep repos", async () => {
    const repos = ["o/r1", "o/r2", "o/r3", "o/r4"].map((name, i) => ({
      name,
      head: `s${i}`,
    }));
    const { deps, calls } = fakeDeps(repos, { maxReposPerSweep: 2 });
    const summary = await runSkillsResyncSweep(ORG, deps);
    expect(summary.reposListed).toBe(4);
    expect(summary.reposScanned).toBe(2);
    expect(calls.headChecks).toEqual(["o/r1", "o/r2"]);
  });

  test("a failed repo is isolated: logged, counted, the rest still sync", async () => {
    const { deps, calls } = fakeDeps([
      { name: "o/ok1", head: "s1", candidates: ["x/SKILL.md"] },
      { name: "o/boom", head: "s2", failScan: true },
      { name: "o/ok2", head: "s3", candidates: ["y/SKILL.md"] },
    ]);
    const summary = await runSkillsResyncSweep(ORG, deps);
    expect(summary.reposFailed).toBe(1);
    expect(summary.reposScanned).toBe(2); // a failed repo counts as failed, not scanned
    expect(summary.created).toBe(2);
    expect(calls.imports.map((i) => i.repo)).toEqual(["o/ok1", "o/ok2"]);
  });

  test("a failed HEAD probe is isolated too and never reaches scan", async () => {
    const { deps, calls } = fakeDeps([
      { name: "o/deadhead", head: "s1", failHead: true },
      { name: "o/ok", head: "s2", candidates: ["z/SKILL.md"] },
    ]);
    const summary = await runSkillsResyncSweep(ORG, deps);
    expect(summary.reposFailed).toBe(1);
    expect(calls.scans).toEqual(["o/ok"]);
    expect(summary.created).toBe(1);
  });

  test("unchanged HEAD short-circuits the second sweep before any scan", async () => {
    const repos: FakeRepo[] = [{ name: "o/stable", head: "sha-1", candidates: ["s/SKILL.md"] }];
    const { deps, calls } = fakeDeps(repos);

    const first = await runSkillsResyncSweep(ORG, deps);
    expect(first.reposScanned).toBe(1);

    const second = await runSkillsResyncSweep(ORG, deps);
    expect(second.reposScanned).toBe(0);
    expect(second.reposUnchangedHead).toBe(1);
    expect(calls.scans).toEqual(["o/stable"]); // only the first sweep cloned

    // HEAD moves → the repo is scanned again.
    repos[0]!.head = "sha-2";
    const third = await runSkillsResyncSweep(ORG, deps);
    expect(third.reposScanned).toBe(1);
    expect(third.reposUnchangedHead).toBe(0);
  });

  test("a failed import does NOT record the HEAD, so the next sweep retries", async () => {
    const repos: FakeRepo[] = [{ name: "o/flaky", head: "sha-1", candidates: ["f/SKILL.md"] }];
    const { deps, calls } = fakeDeps(repos, {
      importPaths: async () => {
        throw new Error("db unique violation");
      },
    });
    const first = await runSkillsResyncSweep(ORG, deps);
    expect(first.reposFailed).toBe(1);

    const second = await runSkillsResyncSweep(ORG, deps);
    expect(second.reposUnchangedHead).toBe(0); // not short-circuited
    expect(calls.scans).toEqual(["o/flaky", "o/flaky"]);
  });

  test("a repo with no candidates records its HEAD without calling import", async () => {
    const { deps, calls } = fakeDeps([{ name: "o/empty", head: "sha-e" }]);
    const first = await runSkillsResyncSweep(ORG, deps);
    expect(first.reposScanned).toBe(1);
    expect(calls.imports).toEqual([]);

    const second = await runSkillsResyncSweep(ORG, deps);
    expect(second.reposUnchangedHead).toBe(1);
  });

  test("unconfigured github is a quiet no-op sweep", async () => {
    const { deps, calls } = fakeDeps([], {
      listRepos: async () => ({ configured: false, repos: [] }),
    });
    const summary = await runSkillsResyncSweep(ORG, deps);
    expect(summary.reposListed).toBe(0);
    expect(summary.reposScanned).toBe(0);
    expect(calls.headChecks).toEqual([]);
  });

  test("a degraded listing (configured but errored) scans nothing", async () => {
    const { deps, calls } = fakeDeps([], {
      listRepos: async () => ({ configured: true, repos: [], error: "GitHub API 502" }),
    });
    const summary = await runSkillsResyncSweep(ORG, deps);
    expect(summary.reposScanned).toBe(0);
    expect(calls.headChecks).toEqual([]);
  });

  test("a thrown listing is contained (never propagates)", async () => {
    const { deps } = fakeDeps([], {
      listRepos: async () => {
        throw new Error("network down");
      },
    });
    const summary = await runSkillsResyncSweep(ORG, deps);
    expect(summary.reposListed).toBe(0);
    expect(summary.reposFailed).toBe(0);
  });

  test("the sha cache is org-scoped: another org rescans the same repo", async () => {
    const { deps, calls } = fakeDeps([{ name: "o/shared", head: "sha-s" }]);
    await runSkillsResyncSweep("org-a", deps);
    const other = await runSkillsResyncSweep("org-b", deps);
    expect(other.reposScanned).toBe(1);
    expect(other.reposUnchangedHead).toBe(0);
    expect(calls.scans).toEqual(["o/shared", "o/shared"]);
  });
});
