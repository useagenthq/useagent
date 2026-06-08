import { describe, expect, test } from "bun:test";
import {
  fleetBatchReadEnabled,
  fleetBatchRolloutMode,
  fleetBatchWriteEnabled,
} from "./batch-rollout";

describe("fleet batch rollout", () => {
  test("fails closed and separates read from write authority", () => {
    expect(fleetBatchRolloutMode({})).toBe("off");
    expect(fleetBatchRolloutMode({ FLEET_BATCH_ROLLOUT: "invalid" })).toBe("off");
    expect(fleetBatchReadEnabled({ FLEET_BATCH_ROLLOUT: "read" })).toBe(true);
    expect(fleetBatchWriteEnabled({ FLEET_BATCH_ROLLOUT: "read" })).toBe(false);
    expect(fleetBatchWriteEnabled({ FLEET_BATCH_ROLLOUT: " WRITE " })).toBe(true);
  });
});
