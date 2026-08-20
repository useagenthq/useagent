import { beforeEach, describe, expect, test } from "bun:test";
import { DEV_ORG_ID } from "../src/seed";
import {
  clearCodeIndexStateForTest,
  codeIndexConfig,
  runCodeIndexSweep,
  type CodeIndexDeps,
  type RepoSnapshot,
} from "../src/context/code/index-sweep";

// ---------------------------------------------------------------------------
// Repository code-index sweep orchestration, unit-tested with injected fakes
// (repo lister / head resolver / snapshotter / projector) - zero GitHub, zero
// clone, zero DB. Mirrors skills-resync.test.ts: disabled-by-default config,
// serial pacing, per-sweep bounds, per-repo error isolation, the unchanged-HEAD
// short-circuit (5.3 incrementality: a restart never full-rescans), and honest
// summary tallies.
// ---------------------------------------------------------------------------

const ORG = "org-code-index-test";

interface FakeRepo {
  name: string;
  head: string;
  /** Records projected when this repo is snapshot (default 1). */
  records?: number;
  failHead?: boolean;
  failSnapshot?: boolean;
}

interface Calls {
  sleeps: number[];
  headChecks: string[];
  snapshots: string[];
  projections: { repo: string; count: number }[];
}

function fakeDeps(
  repos: FakeRepo[],
  overrides: Partial<CodeIndexDeps> = {},
): { deps: CodeIndexDeps; calls: Calls } {
  const calls: Calls = { sleeps: [], headChecks: [], snapshots: [], projections: [] };
  const byName = new Map(repos.map((r) => [r.name, r]));
  const deps: CodeIndexDeps = {
    listRepos: async () => ({
      configured: true,
      repos: repos.map((r) => ({ full_name: r.name })),
    }),
    resolveHeadSha: async (repo) => {
      calls.headChecks.push(repo);
      const r = byName.get(repo)!;
      if (r.failHead) throw new Error(`ls-remote failed for ${repo}`);
      return r.head;
    },
    snapshot: async (repo): Promise<RepoSnapshot> => {
      calls.snapshots.push(repo);
      const r = byName.get(repo)!;
      if (r.failSnapshot) throw new Error(`clone failed for ${repo}`);
      return { commitSha: r.head, files: [] };
    },
    projectRecords: async (_orgId, repo, snap) => {
      const r = byName.get(repo)!;
      const count = r.records ?? 1;
      calls.projections.push({ repo, count });
      void snap;
      return count;
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
  clearCodeIndexStateForTest();
  delete process.env.CODE_INDEX_INTERVAL_MIN;
  delete process.env.CODE_INDEX_ORG_ID;
});

describe("codeIndexConfig", () => {
  test("disabled by default: unset / 0 / negative / garbage all resolve to null", () => {
    expect(codeIndexConfig({})).toBeNull();
    expect(codeIndexConfig({ CODE_INDEX_INTERVAL_MIN: "0" })).toBeNull();
    expect(codeIndexConfig({ CODE_INDEX_INTERVAL_MIN: "-5" })).toBeNull();
    expect(codeIndexConfig({ CODE_INDEX_INTERVAL_MIN: "later" })).toBeNull();
  });

  test("a positive interval enables; org defaults to the dev org, override wins", () => {
    expect(codeIndexConfig({ CODE_INDEX_INTERVAL_MIN: "30" })).toEqual({
      intervalMin: 30,
      orgId: DEV_ORG_ID,
    });
    expect(
      codeIndexConfig({ CODE_INDEX_INTERVAL_MIN: "60", CODE_INDEX_ORG_ID: "org-prod" }),
    ).toEqual({ intervalMin: 60, orgId: "org-prod" });
  });
});

describe("runCodeIndexSweep", () => {
  test("indexes each repo serially and tallies projected records", async () => {
    const { deps, calls } = fakeDeps([
      { name: "acme/dns", head: "sha-a", records: 5 },
      { name: "acme/web", head: "sha-b", records: 3 },
    ]);
    const summary = await runCodeIndexSweep(ORG, deps);
    expect(summary).toEqual({
      reposListed: 2,
      reposIndexed: 2,
      reposUnchangedHead: 0,
      reposFailed: 0,
      recordsProjected: 8,
    });
    expect(calls.snapshots).toEqual(["acme/dns", "acme/web"]);
  });

  test("paces BETWEEN repos: n-1 sleeps, none before the first", async () => {
    const { deps, calls } = fakeDeps(
      [
        { name: "o/r1", head: "s1" },
        { name: "o/r2", head: "s2" },
        { name: "o/r3", head: "s3" },
      ],
      { repoPacingMs: 250 },
    );
    await runCodeIndexSweep(ORG, deps);
    expect(calls.sleeps).toEqual([250, 250]);
  });

  test("bounds a sweep to maxReposPerSweep repos", async () => {
    const repos = ["o/r1", "o/r2", "o/r3", "o/r4"].map((name, i) => ({
      name,
      head: `s${i}`,
    }));
    const { deps, calls } = fakeDeps(repos, { maxReposPerSweep: 2 });
    const summary = await runCodeIndexSweep(ORG, deps);
    expect(summary.reposListed).toBe(4);
    expect(summary.reposIndexed).toBe(2);
    expect(calls.headChecks).toEqual(["o/r1", "o/r2"]);
  });

  test("a failed snapshot is isolated: logged, counted, the rest still index", async () => {
    const { deps, calls } = fakeDeps([
      { name: "o/ok1", head: "s1", records: 2 },
      { name: "o/boom", head: "s2", failSnapshot: true },
      { name: "o/ok2", head: "s3", records: 4 },
    ]);
    const summary = await runCodeIndexSweep(ORG, deps);
    expect(summary.reposFailed).toBe(1);
    expect(summary.reposIndexed).toBe(2);
    expect(summary.recordsProjected).toBe(6);
    expect(calls.projections.map((p) => p.repo)).toEqual(["o/ok1", "o/ok2"]);
  });

  test("a failed HEAD probe is isolated and never reaches snapshot", async () => {
    const { deps, calls } = fakeDeps([
      { name: "o/deadhead", head: "s1", failHead: true },
      { name: "o/ok", head: "s2", records: 1 },
    ]);
    const summary = await runCodeIndexSweep(ORG, deps);
    expect(summary.reposFailed).toBe(1);
    expect(calls.snapshots).toEqual(["o/ok"]);
  });

  test("unchanged HEAD short-circuits the second sweep before any snapshot (5.3)", async () => {
    const repos: FakeRepo[] = [{ name: "o/stable", head: "sha-1", records: 3 }];
    const { deps, calls } = fakeDeps(repos);

    const first = await runCodeIndexSweep(ORG, deps);
    expect(first.reposIndexed).toBe(1);

    const second = await runCodeIndexSweep(ORG, deps);
    expect(second.reposIndexed).toBe(0);
    expect(second.reposUnchangedHead).toBe(1);
    expect(calls.snapshots).toEqual(["o/stable"]); // only the first sweep cloned

    // HEAD moves -> the repo is re-indexed.
    repos[0]!.head = "sha-2";
    const third = await runCodeIndexSweep(ORG, deps);
    expect(third.reposIndexed).toBe(1);
    expect(third.reposUnchangedHead).toBe(0);
  });

  test("a failed snapshot does NOT record the HEAD, so the next sweep retries", async () => {
    const repos: FakeRepo[] = [{ name: "o/flaky", head: "sha-1" }];
    const { deps, calls } = fakeDeps(repos, {
      snapshot: async () => {
        throw new Error("clone timed out");
      },
    });
    await runCodeIndexSweep(ORG, deps);
    const second = await runCodeIndexSweep(ORG, deps);
    expect(second.reposUnchangedHead).toBe(0);
    expect(calls.headChecks).toEqual(["o/flaky", "o/flaky"]);
  });

  test("unconfigured github is a quiet no-op sweep", async () => {
    const { deps, calls } = fakeDeps([], {
      listRepos: async () => ({ configured: false, repos: [] }),
    });
    const summary = await runCodeIndexSweep(ORG, deps);
    expect(summary.reposListed).toBe(0);
    expect(calls.headChecks).toEqual([]);
  });

  test("a thrown listing is contained (never propagates)", async () => {
    const { deps } = fakeDeps([], {
      listRepos: async () => {
        throw new Error("network down");
      },
    });
    const summary = await runCodeIndexSweep(ORG, deps);
    expect(summary.reposListed).toBe(0);
    expect(summary.reposFailed).toBe(0);
  });

  test("the sha cache is org-scoped: another org re-indexes the same repo", async () => {
    const { deps, calls } = fakeDeps([{ name: "o/shared", head: "sha-s" }]);
    await runCodeIndexSweep("org-a", deps);
    const other = await runCodeIndexSweep("org-b", deps);
    expect(other.reposIndexed).toBe(1);
    expect(other.reposUnchangedHead).toBe(0);
    expect(calls.snapshots).toEqual(["o/shared", "o/shared"]);
  });
});
