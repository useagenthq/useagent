import { describe, expect, test } from "bun:test";
import { selectPendingApproval } from "./approval-state";
import type { NativeFrame } from "./native-events";

function frame(seq: number, eventType: string, payload: unknown): NativeFrame {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    seq,
    provider: "t3",
    eventType,
    native: {
      sessionId: "skynet-thread-1",
      parentSessionId: null,
      messageId: null,
      partId: null,
      callId: null,
    },
    payload,
  };
}

describe("native approval state", () => {
  const requested = frame(1, "approval.requested", {
    id: "approval-1",
    sessionID: "skynet-thread-1",
    requestKind: "command",
    detail: "git status",
  });

  test("keeps an approval pending until a durable response or resolution", () => {
    expect(selectPendingApproval([requested])).toMatchObject({ id: "approval-1" });
    expect(
      selectPendingApproval([
        requested,
        frame(2, "approval.responded", { requestId: "approval-1", decision: "accept" }),
      ]),
    ).toBeNull();
  });

  test("ignores malformed or non-T3 approval frames", () => {
    const malformed = frame(2, "approval.requested", { id: "approval-2" });
    expect(selectPendingApproval([malformed])).toBeNull();
    expect(selectPendingApproval([{ ...requested, provider: "opencode" }])).toBeNull();
  });

  test("renders provider-generic approval requests as other", () => {
    expect(selectPendingApproval([
      frame(3, "approval.requested", {
        id: "approval-3",
        sessionID: "skynet-thread-1",
        requestType: "unknown",
        detail: "*",
      }),
    ])).toMatchObject({ id: "approval-3", requestKind: "other" });
  });
});
