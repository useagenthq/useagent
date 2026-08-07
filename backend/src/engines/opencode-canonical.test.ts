// Phase 1 gate: the OpenCode->canonical translator is LOSSLESS at the transport
// boundary and FULLY ACCOUNTED against the protected golden fixture (frontend/
// components/chat/__fixtures__/opencode-heavy.json). Every source frame yields a
// recorded disposition (canonical kinds produced, or a NAMED suppression) - no
// silent drops. Child-session text/reasoning is preserved (with identity); the
// translator hides nothing. Runs alongside the existing lane; no runtime change.

import { describe, expect, test } from "bun:test";
import heavy from "../../../frontend/components/chat/__fixtures__/opencode-heavy.json";
import { translateOpenCode, type OpenCodeFrame } from "./opencode-canonical";
import { assertNeverEvent, type CanonicalAgentEvent } from "./canonical";

const frames = heavy as unknown as OpenCodeFrame[];
const CTX = { runId: "run_test", threadId: "thread_test" };
const { events, accounting } = translateOpenCode(frames, CTX);

function countBy<T>(xs: T[], k: (x: T) => string): Record<string, number> {
  const by: Record<string, number> = {};
  for (const x of xs) by[k(x)] = (by[k(x)] ?? 0) + 1;
  return by;
}
const outKinds = countBy(events, (e) => e.kind);
const srcTypes = countBy(frames, (f) => f.eventType);

function assertKnownKind(e: CanonicalAgentEvent): void {
  switch (e.kind) {
    case "session.started": case "session.metadata": case "turn.started":
    case "turn.completed": case "message.delta": case "message.completed":
    case "reasoning.delta": case "reasoning.completed": case "plan.updated":
    case "tool.started": case "tool.progress": case "tool.completed":
    case "file.changed": case "terminal.output": case "child.started":
    case "child.updated": case "child.completed": case "approval.requested":
    case "approval.resolved": case "question.requested": case "question.resolved":
    case "commands.updated": case "mode.updated": case "usage.updated":
    case "context.marker": case "harness.warning": case "harness.error":
      return;
    default: assertNeverEvent(e);
  }
}

describe("OpenCode -> canonical: accounting + losslessness (golden fixture)", () => {
  test("FULL accounting: one disposition per source frame, none silent", () => {
    expect(accounting.length).toBe(frames.length);
    for (const d of accounting) {
      const ok = d.produced.length > 0 || (typeof d.suppressed === "string" && d.suppressed.length > 0);
      if (!ok) console.log("[canonical] unaccounted:", d);
      expect(ok).toBe(true);
    }
  });

  test("accounting sums exactly to the emitted event stream", () => {
    const summed = accounting.reduce((n, d) => n + d.produced.length, 0);
    expect(summed).toBe(events.length);
  });

  test("no source event maps to an 'unmapped' warning (full coverage)", () => {
    const unmapped = events.filter((e) => e.kind === "harness.warning" && /^unmapped/.test((e as { message: string }).message));
    if (unmapped.length) console.log("[canonical] unmapped:", [...new Set(unmapped.map((e) => (e as { rawEventType?: string }).rawEventType))]);
    expect(unmapped.length).toBe(0);
  });

  test("LOSSLESS: every part.text with a messageId is preserved (incl. child sessions)", () => {
    // Slice-1 dropped child text; now it is preserved with identity. message.delta ==
    // all part.text frames carrying a messageId (137 child + 6 root in this fixture).
    const textWithMid = frames.filter((f) => f.eventType.startsWith("part.text") && f.native.messageId).length;
    expect(outKinds["message.delta"] ?? 0).toBe(textWithMid);
    // child sessions are announced (child.started) so reducers can route their parts.
    const childSess = new Set(frames.filter((f) => f.native.parentSessionId && f.native.sessionId).map((f) => f.native.sessionId));
    expect(outKinds["child.started"] ?? 0).toBeGreaterThanOrEqual(childSess.size);
    // and child text carries its session identity (not stripped).
    const childText = events.filter((e) => e.kind === "message.delta" && e.identity.nativeSessionId && childSess.has(e.identity.nativeSessionId));
    expect(childText.length).toBeGreaterThan(0);
    console.log("[canonical] frames:", frames.length, "-> events:", events.length, outKinds);
  });

  test("every emitted event is a KNOWN canonical kind (exhaustive)", () => {
    for (const e of events) assertKnownKind(e);
  });

  test("well-formed envelope + dense monotonic seq + unique ids", () => {
    for (const e of events) {
      expect(e.schemaVersion).toBe(1);
      expect(e.runId).toBe("run_test");
      expect(e.identity.provider.length).toBeGreaterThan(0);
    }
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
  });

  test("tool + reasoning frames map to their canonical kinds", () => {
    expect(outKinds["tool.completed"] ?? 0).toBe((srcTypes["part.tool.completed"] ?? 0) + (srcTypes["part.tool.error"] ?? 0));
    expect(outKinds["reasoning.delta"] ?? 0).toBe(srcTypes["part.reasoning"] ?? 0);
  });
});

// Real fixture has no task-tool fan-out, so prove child.* equivalence on the SAME
// synthetic task frames the legacy deriveChildFidelity golden uses.
describe("child derivation equivalence (synthetic task frames)", () => {
  const taskFrames: OpenCodeFrame[] = [
    { eventId: "e1", seq: 1, provider: "opencode", eventType: "part.tool.completed",
      native: { sessionId: "ses_p", parentSessionId: null, messageId: "m1", partId: "p1", callId: "call_1" },
      payload: { type: "tool", tool: "task", state: { status: "completed", output: '<task id="ses_child1"><task_result>the answer</task_result></task>' } } },
    { eventId: "e2", seq: 2, provider: "opencode", eventType: "part.tool.error",
      native: { sessionId: "ses_p", parentSessionId: null, messageId: "m1", partId: "p2", callId: "call_2" },
      payload: { type: "tool", tool: "task", state: { status: "error", output: "" } } },
  ];
  test("task tool -> child.started + child.completed with derived id/result/status", () => {
    const { events: ev } = translateOpenCode(taskFrames, CTX);
    const done = ev.filter((e) => e.kind === "child.completed") as { childId: string; status: string; result?: string }[];
    expect(ev.filter((e) => e.kind === "child.started").length).toBe(2);
    const c1 = done.find((e) => e.childId === "ses_child1");
    expect(c1?.status).toBe("ok");
    expect(c1?.result).toBe("the answer");
    expect(done.find((e) => e.status === "error")).toBeTruthy();
  });
});
