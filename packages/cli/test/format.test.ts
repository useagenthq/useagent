import { describe, expect, test } from "bun:test";
import { formatFanSummary } from "../src/format";
import type { FanResultLine } from "../src/jsonl";

const results: FanResultLine[] = [
  { prompt: "a", runId: "run_a", status: "completed", verdict: "pass", answer: "ok", url: "u" },
  { prompt: "b", runId: "run_b", status: "failed", verdict: "fail", answer: "", url: "u" },
  { prompt: "c", runId: null, status: "dispatch_error", answer: "", url: null, error: "boom" },
];

describe("formatFanSummary", () => {
  test("renders a header, a row per result, and totals by status", () => {
    const table = formatFanSummary(results);
    expect(table).toContain("RUN");
    expect(table).toContain("STATUS");
    expect(table).toContain("VERDICT");
    expect(table).toContain("run_a");
    expect(table).toContain("3 task(s):");
    expect(table).toContain("1 completed");
    expect(table).toContain("1 failed");
    expect(table).toContain("1 dispatch_error");
  });

  test("adds a verdicts line only when QC ran", () => {
    expect(formatFanSummary(results)).toContain("verdicts:");
    const noQc: FanResultLine[] = [{ prompt: "a", runId: "r", status: "completed", answer: "ok", url: "u" }];
    expect(formatFanSummary(noQc)).not.toContain("verdicts:");
  });
});
