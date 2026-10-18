import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RoutineHistoryList } from "./routine-history";
import type { ApiFiring } from "./types";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");

function makeFiring(patch: Partial<ApiFiring> = {}): ApiFiring {
  return {
    id: "f1",
    run_id: "run-1",
    fired_at: "2026-10-11T09:00:00.000Z",
    trigger: "cron",
    status: "completed",
    run_status: "completed",
    run_summary: null,
    ...patch,
  };
}

describe("RoutineHistoryList", () => {
  test("lists runs newest first with time, status and a link to each run", () => {
    const html = renderToStaticMarkup(
      <RoutineHistoryList
        now={NOW}
        firings={[
          makeFiring({ id: "new", run_id: "run-new", run_summary: "Digest posted to the team channel" }),
          makeFiring({
            id: "old",
            run_id: "run-old",
            fired_at: "2026-10-10T09:00:00.000Z",
            trigger: "manual",
            status: "failed",
            run_status: "failed",
          }),
        ]}
      />,
    );
    const newest = html.indexOf('href="/session/run-new"');
    const oldest = html.indexOf('href="/session/run-old"');
    expect(newest).toBeGreaterThan(-1);
    expect(oldest).toBeGreaterThan(newest);
    expect(html).toContain("completed");
    expect(html).toContain("failed");
    expect(html).toContain("Scheduled");
    expect(html).toContain("Manual");
    expect(html).toContain("2026");
    expect(html).toContain("Digest posted to the team channel");
    expect(html).toContain('aria-label="Open run"');
  });

  test("falls back to the firing status while the run has not settled", () => {
    const html = renderToStaticMarkup(
      <RoutineHistoryList now={NOW} firings={[makeFiring({ status: "queued", run_status: null })]} />,
    );
    expect(html).toContain("queued");
  });

  test("a routine that has never run gets an empty state, not a blank list", () => {
    const html = renderToStaticMarkup(<RoutineHistoryList now={NOW} firings={[]} />);
    expect(html).toContain("No runs yet");
    expect(html).toContain("has not fired yet");
    expect(html).not.toContain("<ol");
  });
});
