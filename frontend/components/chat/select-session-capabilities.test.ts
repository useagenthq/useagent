// Phase 6: surface visibility gates on the ONE negotiated capability map from the DURABLE
// canonical stream's `session.started`, SESSION-SCOPED so an other-session snapshot never leaks
// in. A session that has not started yet -> null (caller falls back to a pre-session heuristic).
import { describe, expect, test } from "bun:test";
import { selectSessionCapabilities, type StoredCanonicalEvent } from "./canonical-timeline";

function started(over: { runId: string; deliverySeq: number; sessionId: string; capabilities: Record<string, boolean> }): StoredCanonicalEvent {
  return {
    schemaVersion: 1, kind: "session.started", eventId: `${over.runId}:${over.sessionId}:session`,
    runId: over.runId, threadId: "t", seq: 0, deliverySeq: over.deliverySeq, revision: 0,
    identity: { nativeSessionId: over.sessionId }, capabilities: over.capabilities,
  } as StoredCanonicalEvent;
}
const other = (runId: string, deliverySeq: number): StoredCanonicalEvent =>
  ({ schemaVersion: 1, kind: "message.delta", eventId: `${runId}:d`, runId, threadId: "t", seq: 0, deliverySeq, revision: 0 } as StoredCanonicalEvent);

describe("selectSessionCapabilities", () => {
  test("null sessionId, or a session that never started -> null (fall back to heuristic)", () => {
    expect(selectSessionCapabilities([{ canonical: [started({ runId: "r", deliverySeq: 1, sessionId: "s", capabilities: { desktop: true } })] }], null)).toBeNull();
    expect(selectSessionCapabilities([{ canonical: [other("r", 1)] }], "s")).toBeNull();
  });

  test("returns the CURRENT session's capability map, ignoring other sessions", () => {
    const runs = [
      { canonical: [started({ runId: "r1", deliverySeq: 9, sessionId: "OLD", capabilities: { desktop: true, nativeEmbed: true } })] },
      { canonical: [started({ runId: "r2", deliverySeq: 3, sessionId: "CUR", capabilities: { desktop: false, nativeEmbed: false, commands: true } })] },
    ];
    const caps = selectSessionCapabilities(runs, "CUR");
    expect(caps?.desktop).toBe(false);
    expect(caps?.nativeEmbed).toBe(false);
    expect(caps?.commands).toBe(true);
  });

  test("the latest session.started for the SAME session wins (by deliverySeq)", () => {
    const runs = [
      { canonical: [started({ runId: "r", deliverySeq: 2, sessionId: "s", capabilities: { desktop: false } })] },
      { canonical: [started({ runId: "r", deliverySeq: 7, sessionId: "s", capabilities: { desktop: true } })] },
    ];
    expect(selectSessionCapabilities(runs, "s")?.desktop).toBe(true);
  });
});
