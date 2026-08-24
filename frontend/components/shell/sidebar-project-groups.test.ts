import { describe, expect, test } from "bun:test";

import {
  groupThreadsByProject,
  runPrimaryRepo,
  UNATTACHED_KEY,
  type ProjectRepo,
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
      runPrimaryRepo(run({ id: "a", repo_specs: [{ repo: "acme/api", branch: null }], repos: ["acme/web"], repo: "acme/legacy" })),
    ).toBe("acme/api");
    expect(runPrimaryRepo(run({ id: "b", repos: ["acme/web"], repo: "acme/legacy" }))).toBe("acme/web");
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
