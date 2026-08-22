import { describe, expect, test } from "bun:test";
import { recentRuns, type DashRun } from "./dashboard-data";

function run(id: string, createdAt: string): DashRun {
  return {
    id,
    prompt: id,
    model: null,
    engine: null,
    repo: null,
    status: "completed",
    duration_ms: null,
    created_at: createdAt,
  };
}

describe("recent dashboard runs", () => {
  test("sorts newest first and bounds the client payload", () => {
    expect(
      recentRuns(
        [
          run("old", "2026-08-20T00:00:00Z"),
          run("new", "2026-08-22T00:00:00Z"),
          run("middle", "2026-08-21T00:00:00Z"),
        ],
        2,
      ).map((item) => item.id),
    ).toEqual(["new", "middle"]);
  });
});
