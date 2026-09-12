import { describe, expect, test } from "bun:test";
import { projectProductThreadStatus } from "./thread-status";

describe("projectProductThreadStatus", () => {
  test("terminal and durable cancellation outrank stale admission state", () => {
    expect(projectProductThreadStatus({
      runStatus: "completed",
      admissionState: "running",
      queueReason: null,
      cancelIntent: false,
    })).toBe("completed");
    expect(projectProductThreadStatus({
      runStatus: "failed",
      admissionState: "failed",
      queueReason: null,
      cancelIntent: true,
    })).toBe("cancelled");
  });

  test("only capacity queue reasons project waiting", () => {
    expect(projectProductThreadStatus({
      runStatus: "queued",
      admissionState: "queued",
      queueReason: "provider_capacity",
      cancelIntent: false,
    })).toBe("waiting");
    expect(projectProductThreadStatus({
      runStatus: "queued",
      admissionState: "leased",
      queueReason: null,
      cancelIntent: false,
    })).toBe("queued");
  });
});
