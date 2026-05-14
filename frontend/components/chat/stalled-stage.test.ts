import { describe, expect, test } from "bun:test";
import { STALLED_STAGE_THRESHOLD_MS, stalledStageElapsed } from "./types";

describe("stalledStageElapsed", () => {
  test("shows no affordance until the stage has stalled past the threshold", () => {
    expect(STALLED_STAGE_THRESHOLD_MS).toBe(2000);
    expect(stalledStageElapsed(0)).toBeNull();
    expect(stalledStageElapsed(1999)).toBeNull();
  });

  test("tails whole-second elapsed time once the stage stalls", () => {
    // Exactly at the threshold the affordance appears.
    expect(stalledStageElapsed(2000)).toBe("2s");
    // Whole seconds only (no decimal), floored - "Booting OpenCode 4s".
    expect(stalledStageElapsed(4200)).toBe("4s");
    expect(stalledStageElapsed(4999)).toBe("4s");
    expect(stalledStageElapsed(60000)).toBe("60s");
  });

  test("treats a NaN elapsed as below threshold (never fabricates a count)", () => {
    expect(stalledStageElapsed(Number.NaN)).toBeNull();
  });
});
