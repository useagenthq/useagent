import { describe, expect, test } from "bun:test";
import { parseGatewayApproval } from "@/lib/gateway-approvals";
import type { StoredCanonicalEvent } from "./canonical-timeline";
import {
  beginResolution,
  effectiveStatus,
  gatewayApprovalSignature,
  hasGatewayApprovalSignal,
  idleResolution,
  resolutionFailed,
  resolutionSucceeded,
  summarizeApprovalArguments,
} from "./gateway-approval-state";
import type { NativeFrame } from "./native-events";
import type { ApiStep } from "./types";

function step(id: string, chip: string | null, kind: ApiStep["kind"] = "task"): ApiStep {
  return {
    id,
    run_id: "run-1",
    idx: 1,
    kind,
    label: "label",
    chip,
    code_json: null,
    created_at: "2026-08-20T10:00:00Z",
  };
}

function frame(seq: number, provider: string, eventType: string): NativeFrame {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    seq,
    provider,
    eventType,
    native: {
      sessionId: null,
      parentSessionId: null,
      messageId: null,
      partId: null,
      callId: null,
    },
    payload: {},
  };
}

function canonical(eventId: string, kind: string): StoredCanonicalEvent {
  return {
    schemaVersion: 1,
    eventId,
    runId: "run-1",
    threadId: "thread-1",
    deliverySeq: 1,
    revision: 1,
    kind,
    seq: 1,
    identity: { nativeEventId: eventId, nativeSeq: 1 },
  } as StoredCanonicalEvent;
}

describe("gateway approval timeline decision", () => {
  test("a step whose chip contains approval signals the lane", () => {
    expect(hasGatewayApprovalSignal([step("s1", "approval")], [])).toBe(true);
    expect(hasGatewayApprovalSignal([step("s1", "gateway-approval")], [])).toBe(true);
  });

  test("ordinary steps and frames never signal", () => {
    expect(
      hasGatewayApprovalSignal(
        [step("s1", "bash", "command")],
        [frame(1, "opencode", "part.tool.completed")],
      ),
    ).toBe(false);
  });

  test("a non-native provider event containing approval signals the lane", () => {
    expect(
      hasGatewayApprovalSignal([], [frame(1, "skynet", "gateway.approval.requested")]),
    ).toBe(true);
  });

  test("the T3 native approval lane is excluded (NativeApprovalCard owns it)", () => {
    expect(hasGatewayApprovalSignal([], [frame(1, "t3", "approval.requested")])).toBe(false);
  });

  test("a canonical event whose kind contains approval signals the lane", () => {
    expect(
      hasGatewayApprovalSignal([], [], [canonical("ce-1", "approval.requested")]),
    ).toBe(true);
    expect(hasGatewayApprovalSignal([], [], [canonical("ce-1", "tool.started")])).toBe(false);
  });

  test("the signature changes when a resolution event re-projects (SSE revalidate)", () => {
    const before = gatewayApprovalSignature(
      [],
      [frame(1, "skynet", "gateway.approval.requested")],
    );
    const after = gatewayApprovalSignature(
      [],
      [
        frame(1, "skynet", "gateway.approval.requested"),
        frame(2, "skynet", "gateway.approval.resolved"),
      ],
    );
    expect(before).not.toBe("");
    expect(after).not.toBe(before);
  });
});

describe("argument summary (one level, truncated, order-preserving)", () => {
  test("strings render verbatim and non-strings render as JSON", () => {
    expect(
      summarizeApprovalArguments({ service: "billing", replicas: 3, force: true }),
    ).toEqual([
      { key: "service", value: "billing" },
      { key: "replicas", value: "3" },
      { key: "force", value: "true" },
    ]);
  });

  test("long values truncate to a bounded single line", () => {
    const long = "x".repeat(200);
    const [entry] = summarizeApprovalArguments({ script: long });
    expect(entry?.value.length).toBe(80);
    expect(entry?.value.endsWith("…")).toBe(true);
  });

  test("nested objects stay one level deep as JSON and newlines flatten", () => {
    expect(summarizeApprovalArguments({ env: { region: "eu" }, cmd: "a\nb" })).toEqual([
      { key: "env", value: '{"region":"eu"}' },
      { key: "cmd", value: "a b" },
    ]);
  });
});

describe("optimistic resolution machine", () => {
  test("begin enters submitting once; a second begin in flight is a no-op", () => {
    const submitting = beginResolution(idleResolution, "approve");
    expect(submitting).toEqual({ phase: "submitting", decision: "approve" });
    expect(beginResolution(submitting, "deny")).toBe(submitting);
  });

  test("a pending record shows the optimistic decision while submitting", () => {
    expect(effectiveStatus("pending", beginResolution(idleResolution, "approve"))).toBe(
      "approved",
    );
    expect(effectiveStatus("pending", beginResolution(idleResolution, "deny"))).toBe("denied");
  });

  test("success settles on the server-confirmed status", () => {
    expect(effectiveStatus("pending", resolutionSucceeded("approved"))).toBe("approved");
  });

  test("failure rolls back to pending with mapped copy", () => {
    const forbidden = resolutionFailed(403);
    expect(effectiveStatus("pending", forbidden)).toBe("pending");
    expect(forbidden).toEqual({ phase: "idle", error: "An org member must approve this" });
    expect(resolutionFailed(409)).toEqual({
      phase: "idle",
      error: "Already resolved by someone else - refreshing",
    });
    expect(resolutionFailed(null)).toEqual({
      phase: "idle",
      error: "Could not send your decision - try again",
    });
  });

  test("a server-resolved record always wins over local state", () => {
    expect(effectiveStatus("expired", beginResolution(idleResolution, "approve"))).toBe(
      "expired",
    );
    expect(effectiveStatus("denied", resolutionSucceeded("approved"))).toBe("denied");
  });
});

describe("wire parse (contract boundary)", () => {
  const wire = {
    id: "appr-1",
    runId: "run-1",
    toolName: "deploy_service",
    arguments: { service: "billing" },
    status: "pending",
    requestedAt: "2026-08-20T10:00:00Z",
    resolvedAt: null,
  };

  test("parses a contract-shaped record", () => {
    expect(parseGatewayApproval(wire)).toEqual({
      id: "appr-1",
      runId: "run-1",
      toolName: "deploy_service",
      arguments: { service: "billing" },
      status: "pending",
      requestedAt: "2026-08-20T10:00:00Z",
      resolvedAt: null,
      resolvedBy: null,
    });
  });

  test("drops unknown statuses and records missing identity", () => {
    expect(parseGatewayApproval({ ...wire, status: "vetoed" })).toBeNull();
    expect(parseGatewayApproval({ ...wire, id: "" })).toBeNull();
    expect(parseGatewayApproval("nope")).toBeNull();
  });

  test("malformed arguments degrade to an empty object, optional fields parse", () => {
    expect(
      parseGatewayApproval({
        ...wire,
        arguments: ["not", "a", "record"],
        status: "approved",
        resolvedAt: "2026-08-20T10:01:00Z",
        resolvedBy: "dana",
      }),
    ).toMatchObject({ arguments: {}, resolvedAt: "2026-08-20T10:01:00Z", resolvedBy: "dana" });
  });
});
