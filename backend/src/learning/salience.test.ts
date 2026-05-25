/**
 * Pure salience tests (item 4). The high-value verdict is deterministic facts
 * in → reason out; these pin the gate so the draft producer's judgments are
 * reproducible and a threshold change is a deliberate, visible edit.
 */
import { describe, expect, test } from "bun:test";
import {
  highValueReason,
  LONG_RUN_MIN_STEP_KINDS,
  LONG_RUN_MIN_STEPS,
} from "./salience";

const base = { status: "completed", artifactCount: 0, stepCount: 0, distinctStepKinds: 0 };

describe("highValueReason", () => {
  test("published artifacts make a completed run high-value", () => {
    expect(highValueReason({ ...base, artifactCount: 1 })).toBe("published_artifacts");
    expect(highValueReason({ ...base, artifactCount: 5 })).toBe("published_artifacts");
  });

  test("a long multi-tool run is high-value without artifacts", () => {
    expect(
      highValueReason({
        ...base,
        stepCount: LONG_RUN_MIN_STEPS,
        distinctStepKinds: LONG_RUN_MIN_STEP_KINDS,
      }),
    ).toBe("long_multi_tool_run");
  });

  test("artifacts take precedence over run length", () => {
    expect(
      highValueReason({ ...base, artifactCount: 1, stepCount: 50, distinctStepKinds: 3 }),
    ).toBe("published_artifacts");
  });

  test("short or single-tool runs are not high-value", () => {
    expect(highValueReason(base)).toBeNull();
    // Long but single-kind: below the multi-tool bar.
    expect(
      highValueReason({ ...base, stepCount: LONG_RUN_MIN_STEPS + 5, distinctStepKinds: 1 }),
    ).toBeNull();
    // Multi-kind but short: below the length bar.
    expect(
      highValueReason({
        ...base,
        stepCount: LONG_RUN_MIN_STEPS - 1,
        distinctStepKinds: LONG_RUN_MIN_STEP_KINDS,
      }),
    ).toBeNull();
  });

  test("non-completed runs are never high-value, whatever they produced", () => {
    for (const status of ["queued", "running", "failed"]) {
      expect(
        highValueReason({ status, artifactCount: 3, stepCount: 40, distinctStepKinds: 4 }),
      ).toBeNull();
    }
  });
});
