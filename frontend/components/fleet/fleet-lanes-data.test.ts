import { describe, expect, test } from "bun:test";
import { extractRuns, groupIntoLanes } from "./fleet-lanes-data";

describe("fleet project grouping", () => {
  test("groups runs by the authoritative repository metadata", () => {
    const runs = extractRuns({
      runs: [
        {
          id: "newer",
          prompt: "Growth Operator should never become a project name",
          status: "running",
          created_at: "2026-08-22T03:00:00Z",
          repo_specs: [{ repo: "upstream-org/backend", branch: "main" }],
          repos: ["ignored/fallback"],
        },
        {
          id: "older",
          status: "completed",
          created_at: "2026-08-22T02:00:00Z",
          repos: ["upstream-org/backend"],
        },
        {
          id: "frontend",
          status: "completed",
          created_at: "2026-08-22T01:00:00Z",
          repo: "upstream-org/frontend",
        },
      ],
    });

    expect(groupIntoLanes(runs)).toEqual([
      {
        name: "upstream-org/backend",
        label: "backend",
        runs: [runs[0], runs[1]],
        working: 1,
      },
      {
        name: "upstream-org/frontend",
        label: "frontend",
        runs: [runs[2]],
        working: 0,
      },
    ]);
  });

  test("omits repository-less runs instead of assigning placeholder lanes", () => {
    const runs = extractRuns({
      runs: [
        {
          id: "no-repo",
          prompt: "Content Pipeline",
          status: "completed",
          created_at: "2026-08-22T01:00:00Z",
        },
      ],
    });

    expect(groupIntoLanes(runs)).toEqual([]);
  });
});
