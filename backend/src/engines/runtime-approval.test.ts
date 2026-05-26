import { describe, expect, test } from "bun:test";
import {
  assertRuntimeApprovalPending,
  RuntimeApprovalError,
  validateRuntimeApprovalDecision,
} from "./runtime-approval";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";

function snapshot(resolved = false): RuntimeThreadSnapshot {
  return {
    snapshotSequence: resolved ? 3 : 2,
    thread: {
      id: "skynet-thread-thread-1",
      latestTurn: { turnId: "turn-1", state: "running", assistantMessageId: null },
      messages: [],
      activities: [
        {
          id: "activity-approval",
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: { requestId: "approval-1", requestKind: "command", detail: "git status" },
          turnId: "turn-1",
        },
        ...(resolved
          ? [{
              id: "activity-resolved",
              tone: "approval" as const,
              kind: "approval.resolved",
              summary: "Approval resolved",
              payload: { requestId: "approval-1", decision: "accept" },
              turnId: "turn-1",
            }]
          : []),
      ],
      session: { status: "running", lastError: null },
    },
  };
}

describe("T3 native approvals", () => {
  test("accepts only T3's native decisions", () => {
    expect(validateRuntimeApprovalDecision("acceptForSession")).toBe("acceptForSession");
    expect(() => validateRuntimeApprovalDecision("always")).toThrow(RuntimeApprovalError);
  });

  test("returns the pending request and fails closed once resolved", () => {
    expect(assertRuntimeApprovalPending(
      snapshot(),
      "skynet-thread-thread-1",
      "approval-1",
    )).toMatchObject({ id: "approval-1", requestKind: "command" });
    expect(() => assertRuntimeApprovalPending(
      snapshot(true),
      "skynet-thread-thread-1",
      "approval-1",
    )).toThrow(RuntimeApprovalError);
  });

  test("keeps provider-generic approvals actionable without misclassifying them", () => {
    const base = snapshot();
    const generic: RuntimeThreadSnapshot = {
      ...base,
      thread: {
        ...base.thread,
        activities: [{
          ...base.thread.activities[0]!,
          payload: { requestId: "approval-1", requestType: "unknown", detail: "*" },
        }],
      },
    };
    expect(assertRuntimeApprovalPending(
      generic,
      "skynet-thread-thread-1",
      "approval-1",
    )).toMatchObject({ id: "approval-1", requestKind: "other" });
  });
});
