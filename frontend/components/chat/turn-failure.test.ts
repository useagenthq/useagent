import { describe, expect, test } from "bun:test";
import { failureRow, turnFailure } from "./turn-failure";
import type { ApiStep } from "./types";

// Synthetic relay boot failure. The backend stores the reason on run.summary,
// and the done step carries only the category. The UI must show every
// character it was given.
const REASON =
  "error: synthetic engine relay stopped during startup after the child process exited before signaling readiness. Diagnostic output remains visible in full so operators can copy the complete failure context.";

const step = (idx: number, kind: ApiStep["kind"], label: string, chip: string | null): ApiStep => ({
  id: `st${idx}`,
  run_id: "run-synthetic-boot-failure",
  idx,
  kind,
  label,
  chip,
  code_json: null,
  created_at: "2030-01-01T00:00:00.000Z",
});

const BOOT_FAILURE_STEPS: ApiStep[] = [
  step(0, "task", "Preparing context and runtime…", "boot"),
  step(1, "task", "Provisioning cloud sandbox…", "claude"),
  step(2, "task", "Sandbox sandbox-demo-02 ready in 4s (4 CPU / 8 GiB)", "claude"),
  step(3, "task", "Preparing browser, tools, and integrations…", "claude"),
  step(4, "done", "Engine error", null),
];

describe("turnFailure", () => {
  test("a failed run pairs the done step's category with the full run.summary reason", () => {
    expect(REASON.length).toBeGreaterThan(180);
    expect(turnFailure({ status: "failed", summary: REASON, steps: BOOT_FAILURE_STEPS })).toEqual({
      label: "Engine error",
      reason: REASON,
    });
  });

  test("a timeout keeps the done step's own words as the category", () => {
    const steps = [
      ...BOOT_FAILURE_STEPS.slice(0, 4),
      step(4, "done", "Timed out after 180s", null),
    ];
    expect(turnFailure({ status: "failed", summary: "Timed out after 180s", steps })?.label).toBe(
      "Timed out after 180s",
    );
  });

  test("a failed run whose done step never landed still names the failure", () => {
    expect(
      turnFailure({ status: "failed", summary: REASON, steps: BOOT_FAILURE_STEPS.slice(0, 4) }),
    ).toEqual({ label: "Run failed", reason: REASON });
  });

  test("completed, live, reasonless and user-stopped runs carry no failure", () => {
    expect(
      turnFailure({ status: "completed", summary: "Done.", steps: BOOT_FAILURE_STEPS }),
    ).toBeNull();
    expect(turnFailure({ status: "running", summary: null, steps: BOOT_FAILURE_STEPS })).toBeNull();
    expect(turnFailure({ status: "failed", summary: null, steps: BOOT_FAILURE_STEPS })).toBeNull();
    const stopped = [...BOOT_FAILURE_STEPS.slice(0, 4), step(4, "done", "Stopped by user", null)];
    expect(
      turnFailure({ status: "failed", summary: "Stopped by user", steps: stopped }),
    ).toBeNull();
  });
});

describe("failureRow", () => {
  test("is a failed terminal row: the category, the reason as its detail, the verbatim reason behind it", () => {
    expect(failureRow({ label: "Engine error", reason: REASON })).toEqual({
      kind: "step",
      key: "failure",
      family: "boot",
      label: "Engine error",
      chip: null,
      detail: REASON,
      status: "failed",
      body: { kind: "failure", reason: REASON },
    });
  });

  test("a multi-line reason shows its first line on the row and every line behind it", () => {
    const reason = "error: clone failed\nfatal: repository not found";
    const row = failureRow({ label: "Engine error", reason });
    expect(row.detail).toBe("error: clone failed");
    expect(row.body).toEqual({ kind: "failure", reason });
  });
});
