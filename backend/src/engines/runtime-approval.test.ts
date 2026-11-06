import { describe, expect, test } from "bun:test";
import {
  assertRuntimeApprovalPending,
  resolveRuntimeApprovalSandbox,
  RuntimeApprovalError,
  validateRuntimeApprovalDecision,
} from "./runtime-approval";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";

function snapshot(resolved = false): RuntimeThreadSnapshot {
  return {
    snapshotSequence: resolved ? 3 : 2,
    thread: {
      id: `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
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
  test("strictly resolves a constrained run without consulting the preview cache", async () => {
    const expectedSandbox = {
      version: 1 as const,
      sandboxId: "sandbox-1",
      provider: "cube" as const,
      credential: "env" as const,
      ownerOrgId: "org-1",
      ownerUserId: null,
      credentialGeneration: "a".repeat(64),
    };
    let expectedCalls = 0;
    let previewCalls = 0;
    const dependencies = {
      expected: async (expected, threadId) => {
        expectedCalls += 1;
        expect(expected).toEqual(expectedSandbox);
        expect(threadId).toBe("thread-1");
        return {} as never;
      },
      preview: async () => {
        previewCalls += 1;
        return {} as never;
      },
    } satisfies Parameters<typeof resolveRuntimeApprovalSandbox>[2];
    await resolveRuntimeApprovalSandbox("thread-1", expectedSandbox, dependencies);
    expect(expectedCalls).toBe(1);
    expect(previewCalls).toBe(0);
    await resolveRuntimeApprovalSandbox("thread-1", null, dependencies);
    expect(expectedCalls).toBe(1);
    expect(previewCalls).toBe(1);
  });

  test("accepts only T3's native decisions", () => {
    expect(validateRuntimeApprovalDecision("acceptForSession")).toBe("acceptForSession");
    expect(() => validateRuntimeApprovalDecision("always")).toThrow(RuntimeApprovalError);
  });

  test("returns the pending request and fails closed once resolved", () => {
    expect(assertRuntimeApprovalPending(
      snapshot(),
      `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      "approval-1",
    )).toMatchObject({ id: "approval-1", requestKind: "command" });
    expect(() => assertRuntimeApprovalPending(
      snapshot(true),
      `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
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
      `${SANDBOX_NAME_PREFIX}-thread-thread-1`,
      "approval-1",
    )).toMatchObject({ id: "approval-1", requestKind: "other" });
  });
});
