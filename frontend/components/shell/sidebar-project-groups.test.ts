import { describe, expect, test } from "bun:test";

import {
  dedupeProjectRepos,
  groupThreadsByProject,
  type ProjectRepo,
  runPrimaryRepo,
  UNATTACHED_KEY,
  visibleProjectGroups,
} from "./sidebar-project-groups";
import type { SidebarRun } from "./working-project-status";

function run(overrides: Partial<SidebarRun> & Pick<SidebarRun, "id">): SidebarRun {
  return {
    prompt: `prompt ${overrides.id}`,
    model: "claude-sonnet-5",
    engine: "opencode",
    status: "completed",
    summary: null,
    duration_ms: null,
    repo: null,
    repos: [],
    repo_specs: [],
    created_at: "2026-08-24T10:00:00Z",
    updated_at: "2026-08-24T10:00:00Z",
    ...overrides,
  } as SidebarRun;
}

const repo = (fullName: string, name = fullName.split("/").at(-1) ?? fullName): ProjectRepo => ({
  fullName,
  name,
});

describe("runPrimaryRepo", () => {
  test("prefers repo_specs, then repos, then the legacy repo", () => {
    expect(
      runPrimaryRepo(
        run({
          id: "a",
          repo_specs: [{ repo: "acme/api", branch: null }],
          repos: ["acme/web"],
          repo: "acme/legacy",
        }),
      ),
    ).toBe("acme/api");
    expect(runPrimaryRepo(run({ id: "b", repos: ["acme/web"], repo: "acme/legacy" }))).toBe(
      "acme/web",
    );
    expect(runPrimaryRepo(run({ id: "c", repo: "acme/legacy" }))).toBe("acme/legacy");
    expect(runPrimaryRepo(run({ id: "d" }))).toBeNull();
  });
});

describe("groupThreadsByProject", () => {
  test("nests each thread under its primary repo", () => {
    const groups = groupThreadsByProject(
      [
        run({ id: "1", repos: ["acme/api"] }),
        run({ id: "2", repos: ["acme/api"] }),
        run({ id: "3", repos: ["acme/web"] }),
      ],
      [repo("acme/api"), repo("acme/web")],
    );
    const api = groups.find((g) => g.fullName === "acme/api");
    const web = groups.find((g) => g.fullName === "acme/web");
    expect(api?.threads.map((t) => t.id)).toEqual(["1", "2"]);
    expect(web?.threads.map((t) => t.id)).toEqual(["3"]);
  });

  test("orders thread-bearing projects by most recent activity first", () => {
    const groups = groupThreadsByProject(
      [
        run({ id: "old", repos: ["acme/api"], updated_at: "2026-08-20T10:00:00Z" }),
        run({ id: "new", repos: ["acme/web"], updated_at: "2026-08-24T10:00:00Z" }),
      ],
      [repo("acme/api"), repo("acme/web")],
    );
    expect(groups.map((g) => g.fullName)).toEqual(["acme/web", "acme/api"]);
  });

  test("sorts threads within a project newest activity first", () => {
    const groups = groupThreadsByProject(
      [
        run({ id: "older", repos: ["acme/api"], updated_at: "2026-08-21T10:00:00Z" }),
        run({ id: "newer", repos: ["acme/api"], updated_at: "2026-08-24T10:00:00Z" }),
      ],
      [repo("acme/api")],
    );
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["newer", "older"]);
  });

  test("sorts running, then queued, then settled by latest activity within each project", () => {
    const groups = groupThreadsByProject(
      [
        run({ id: "done", repos: ["acme/api"], updated_at: "2026-08-24T12:00:00Z" }),
        run({ id: "queued", status: "queued", repos: ["acme/api"] }),
        run({ id: "running", status: "running", repos: ["acme/api"] }),
      ],
      [repo("acme/api")],
    );
    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual(["running", "queued", "done"]);
  });

  test("keeps status ranking isolated to each project and the no-project bucket", () => {
    const groups = groupThreadsByProject(
      [
        run({ id: "api-done", repos: ["acme/api"] }),
        run({ id: "web-running", status: "running", repos: ["acme/web"] }),
        run({ id: "loose-done" }),
        run({ id: "loose-queued", status: "queued" }),
      ],
      [repo("acme/api"), repo("acme/web")],
    );
    expect(
      groups.find((group) => group.fullName === "acme/api")?.threads.map((run) => run.id),
    ).toEqual(["api-done"]);
    expect(
      groups.find((group) => group.fullName === "acme/web")?.threads.map((run) => run.id),
    ).toEqual(["web-running"]);
    expect(
      groups.find((group) => group.key === UNATTACHED_KEY)?.threads.map((run) => run.id),
    ).toEqual(["loose-queued", "loose-done"]);
  });

  test("does not render a duplicated thread id in multiple project groups", () => {
    const groups = groupThreadsByProject(
      [
        run({ id: "same", repos: ["acme/api"], updated_at: "2026-08-20T12:00:00Z" }),
        run({ id: "same", repos: ["acme/web"], updated_at: "2026-08-24T12:00:00Z" }),
      ],
      [repo("acme/api"), repo("acme/web")],
    );
    expect(groups.flatMap((group) => group.threads).map((thread) => thread.id)).toEqual(["same"]);
    expect(groups.find((group) => group.fullName === "acme/web")?.threads).toHaveLength(1);
  });

  test("collects repo-less threads into a single No project bucket, after real projects", () => {
    const groups = groupThreadsByProject(
      [run({ id: "loose" }), run({ id: "attached", repos: ["acme/api"] })],
      [repo("acme/api")],
    );
    const bucket = groups.find((g) => g.key === UNATTACHED_KEY);
    expect(bucket?.name).toBe("No project");
    expect(bucket?.fullName).toBeNull();
    expect(bucket?.threads.map((t) => t.id)).toEqual(["loose"]);
    // Real, thread-bearing projects sort ahead of the unattached bucket.
    expect(groups.map((g) => g.key)).toEqual(["acme/api", UNATTACHED_KEY]);
  });

  test("lists zero-thread repos last, alphabetically, so they can be opened", () => {
    const groups = groupThreadsByProject(
      [run({ id: "1", repos: ["acme/api"] })],
      [repo("acme/api"), repo("acme/zeta"), repo("acme/beta")],
    );
    expect(groups.map((g) => g.fullName)).toEqual(["acme/api", "acme/beta", "acme/zeta"]);
    expect(groups.find((g) => g.fullName === "acme/beta")?.threads).toHaveLength(0);
  });

  test("gives a group to a repo referenced only by a thread, named from owner/name", () => {
    const groups = groupThreadsByProject([run({ id: "1", repos: ["ghost/orphan"] })], []);
    const group = groups.find((g) => g.fullName === "ghost/orphan");
    expect(group?.name).toBe("orphan");
    expect(group?.threads).toHaveLength(1);
  });

  test("prefers the /api/repos display name over the derived short name", () => {
    const groups = groupThreadsByProject(
      [run({ id: "1", repos: ["acme/api"] })],
      [repo("acme/api", "Acme API")],
    );
    expect(groups[0]?.name).toBe("Acme API");
  });

  test("returns nothing when there are no threads and no repos", () => {
    expect(groupThreadsByProject([], [])).toEqual([]);
  });
});

describe("dedupeProjectRepos (Show-N-more count bug)", () => {
  const repo = (fullName: string): ProjectRepo => ({
    fullName,
    name: fullName.split("/")[1] ?? fullName,
  });

  test("collapses duplicate fullNames, first occurrence wins, order preserved", () => {
    const out = dedupeProjectRepos([
      repo("o/a"),
      repo("o/b"),
      repo("o/a"),
      repo("o/c"),
      repo("o/b"),
    ]);
    expect(out.map((r) => r.fullName)).toEqual(["o/a", "o/b", "o/c"]);
  });

  test("unique input is untouched", () => {
    const input = [repo("o/a"), repo("o/b")];
    expect(dedupeProjectRepos(input)).toEqual(input);
  });
});

describe("visibleProjectGroups", () => {
  const groups = ["a", "b", "c", "d", "e", "f"].map((name) => ({
    key: `o/${name}`,
    name,
    fullName: `o/${name}`,
    threads: [],
  }));

  test("keeps the initial project rows visible and counts only the overflow", () => {
    const result = visibleProjectGroups(groups, 5, false);
    expect(result.groups.map((group) => group.name)).toEqual(["a", "b", "c", "d", "e"]);
    expect(result.hiddenCount).toBe(1);
  });

  test("returns every project when expanded", () => {
    expect(visibleProjectGroups(groups, 5, true)).toEqual({ groups, hiddenCount: 0 });
  });
});
