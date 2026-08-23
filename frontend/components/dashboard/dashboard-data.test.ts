import { describe, expect, test } from "bun:test";
import { extractDashboardSummary, recentRuns, type DashRun } from "./dashboard-data";

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

  test("accepts authoritative UTC aggregates and rejects unavailable data", () => {
    expect(extractDashboardSummary(null)).toBeNull();
    expect(
      extractDashboardSummary({
        stats: {
          total: 1_005,
          running: 1,
          queued: 2,
          completed: 1_000,
          failed: 2,
          completed_today: 3,
        },
        counts: { skills: 1_734, knowledge: 120 },
        daily: [{ key: "2026-08-24", label: "Aug 24", total: 3, completed: 2, failed: 1 }],
        weekly: [{ key: "2026-08-24", label: "Aug 24", runs: 5 }],
        settlement_history_from: "2026-08-24T01:02:03.000Z",
        timezone: "UTC",
      }),
    ).toMatchObject({
      stats: { total: 1_005 },
      settlementHistoryFrom: "2026-08-24T01:02:03.000Z",
    });
  });
});
