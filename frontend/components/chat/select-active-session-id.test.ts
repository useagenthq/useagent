// C2: the ONE active native-session id is the CURRENT (newest) run's `session.started`, NOT a
// findLast over historical runs' engine_session_id. Regression: an OLD session S1 replaced by a
// new run whose session S2 has NOT advertised yet must resolve to S2 (or null) - NEVER stale S1.
import { describe, expect, test } from "bun:test";
import { selectActiveSessionId, selectSessionCommands, type StoredCanonicalEvent } from "./canonical-timeline";

function started(over: { runId: string; deliverySeq: number; sessionId: string }): StoredCanonicalEvent {
  return {
    schemaVersion: 1, kind: "session.started", eventId: `${over.runId}:${over.sessionId}:session`,
    runId: over.runId, threadId: "t", seq: 0, deliverySeq: over.deliverySeq, revision: 0,
    identity: { nativeSessionId: over.sessionId }, capabilities: {},
  } as StoredCanonicalEvent;
}
function cmds(over: { runId: string; deliverySeq: number; sessionId: string; catalog: { name: string }[] }): StoredCanonicalEvent {
  return {
    schemaVersion: 1, kind: "commands.updated", eventId: `${over.runId}:${over.sessionId}:commands`,
    runId: over.runId, threadId: "t", seq: 0, deliverySeq: over.deliverySeq, revision: 0,
    identity: { nativeSessionId: over.sessionId }, catalog: over.catalog,
  } as StoredCanonicalEvent;
}

describe("selectActiveSessionId (newest run's session.started is authoritative)", () => {
  test("null newestRunId -> null", () => {
    expect(selectActiveSessionId([{ canonical: [started({ runId: "r1", deliverySeq: 1, sessionId: "S1" })] }], null)).toBeNull();
  });

  test("resolves to the NEWEST run's session even when an older run's session has a HIGHER deliverySeq", () => {
    // findLast-over-history would have picked S1 (older run r1, deliverySeq 9); the newest run r2 owns identity.
    const runs = [
      { canonical: [started({ runId: "r1", deliverySeq: 9, sessionId: "S1" })] },
      { canonical: [started({ runId: "r2", deliverySeq: 3, sessionId: "S2" })] },
    ];
    expect(selectActiveSessionId(runs, "r2")).toBe("S2");
  });

  test("REGRESSION: S1 replaced by a new run r2 that has NOT advertised its session -> null, never stale S1", () => {
    const runs = [
      { canonical: [started({ runId: "r1", deliverySeq: 5, sessionId: "S1" }), cmds({ runId: "r1", deliverySeq: 6, sessionId: "S1", catalog: [{ name: "old-cmd" }] })] },
      { canonical: [] }, // r2 is the newest run but has emitted nothing yet
    ];
    const active = selectActiveSessionId(runs, "r2");
    expect(active).toBeNull();
    // and therefore the stale S1 catalog can NEVER surface for the active session
    expect(selectSessionCommands(runs, active)).toBeNull();
  });

  test("REGRESSION: once r2 advertises S2 (but no commands yet), active=S2 and S1's commands stay hidden", () => {
    const runs = [
      { canonical: [started({ runId: "r1", deliverySeq: 5, sessionId: "S1" }), cmds({ runId: "r1", deliverySeq: 6, sessionId: "S1", catalog: [{ name: "old-cmd" }] })] },
      { canonical: [started({ runId: "r2", deliverySeq: 8, sessionId: "S2" })] }, // S2 started, no commands.updated yet
    ];
    const active = selectActiveSessionId(runs, "r2");
    expect(active).toBe("S2");
    expect(selectSessionCommands(runs, active)).toBeNull(); // S2 has no catalog yet; S1's is NOT shown
  });

  test("the latest session.started for the newest run wins (relay regeneration re-emits)", () => {
    const runs = [
      { canonical: [started({ runId: "r2", deliverySeq: 2, sessionId: "S2a" }), started({ runId: "r2", deliverySeq: 7, sessionId: "S2b" })] },
    ];
    expect(selectActiveSessionId(runs, "r2")).toBe("S2b");
  });
});
