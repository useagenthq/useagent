import { describe, expect, test } from "bun:test";
import type { StoredCanonicalEvent } from "./canonical-timeline";
import type { Turn } from "./conversation";
import type { NativeFrame } from "./native-events";
import type { ApiRun, ApiStep, RunStatus } from "./types";
import { gatewayApprovalSignals } from "./use-gateway-approvals";

function step(id: string, runId: string, chip: string | null): ApiStep {
  return {
    id,
    run_id: runId,
    idx: 1,
    kind: "task",
    label: "label",
    chip,
    code_json: null,
    created_at: "2026-08-20T10:00:00Z",
  };
}

function frame(seq: number, eventType: string): NativeFrame {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    seq,
    provider: "opencode",
    eventType,
    native: { sessionId: null, parentSessionId: null, messageId: null, partId: null, callId: null },
    payload: {},
  };
}

function turn(
  id: string,
  status: RunStatus,
  steps: ApiStep[] = [],
  extra: { frames?: NativeFrame[]; canonical?: StoredCanonicalEvent[] } = {},
): Turn {
  const run = { id, status, steps: [] } as unknown as ApiRun;
  return {
    run,
    steps,
    status,
    summary: null,
    live: status === "running",
    liveText: "",
    liveReasoning: "",
    ...(extra.frames
      ? { native: { nativeFrames: extra.frames } as unknown as Turn["native"] }
      : {}),
    ...(extra.canonical ? { canonical: extra.canonical } : {}),
  };
}

describe("gatewayApprovalSignals", () => {
  test("is empty when no turn has an approval step or event", () => {
    expect(gatewayApprovalSignals([])).toEqual([]);
    expect(
      gatewayApprovalSignals([turn("run-1", "completed", [step("s1", "run-1", "bash")])]),
    ).toEqual([]);
  });

  test("signals approval steps on both running and settled turns, in turn order", () => {
    const signals = gatewayApprovalSignals([
      turn("run-1", "completed", [step("s1", "run-1", "approval")]),
      turn("run-2", "completed", [step("s2", "run-2", "bash")]),
      turn("run-3", "running", [step("s3", "run-3", "approval")]),
    ]);
    expect(signals).toEqual([
      { runId: "run-1", signature: "step:s1" },
      { runId: "run-3", signature: "step:s3" },
    ]);
  });

  test("signals a turn that only has a provider approval event", () => {
    const signals = gatewayApprovalSignals([
      turn("run-1", "running", [], { frames: [frame(4, "permission.approval.requested")] }),
    ]);
    expect(signals).toEqual([{ runId: "run-1", signature: "frame:event-4:4" }]);
  });

  test("changes the signature when a new approval event lands", () => {
    const before = gatewayApprovalSignals([
      turn("run-1", "running", [step("s1", "run-1", "approval")]),
    ]);
    const after = gatewayApprovalSignals([
      turn("run-1", "running", [step("s1", "run-1", "approval")], {
        frames: [frame(9, "approval.resolved")],
      }),
    ]);
    expect(after[0]?.runId).toBe("run-1");
    expect(after[0]?.signature).not.toBe(before[0]?.signature);
  });
});
