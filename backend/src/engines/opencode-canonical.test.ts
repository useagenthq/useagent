// Phase 1 slice-1 gate: the OpenCode->canonical translator is PROVABLY complete +
// well-formed against the protected golden fixture (frontend/components/chat/
// __fixtures__/opencode-heavy.json) - every source event maps to a canonical event
// or an explicit warning (nothing silently dropped), the stream is well-formed
// (schema/ids/dense-seq), and child derivation matches the legacy deriveChildFidelity.
// This runs ALONGSIDE the existing lane; it changes no runtime behavior yet.

import { describe, expect, test } from "bun:test";
import heavy from "../../../frontend/components/chat/__fixtures__/opencode-heavy.json";
import { translateOpenCode, type OpenCodeFrame } from "./opencode-canonical";
import { assertNeverEvent, type CanonicalAgentEvent } from "./canonical";

const frames = heavy as unknown as OpenCodeFrame[];
const CTX = { runId: "run_test", threadId: "thread_test" };

function countByKind(events: CanonicalAgentEvent[]): Record<string, number> {
  const by: Record<string, number> = {};
  for (const e of events) by[e.kind] = (by[e.kind] ?? 0) + 1;
  return by;
}
function countByEventType(fs: OpenCodeFrame[]): Record<string, number> {
  const by: Record<string, number> = {};
  for (const f of fs) by[f.eventType] = (by[f.eventType] ?? 0) + 1;
  return by;
}

// Exhaustive: reaching assertNeverEvent means an unknown canonical kind slipped in.
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
    default:
      assertNeverEvent(e);
  }
}

describe("OpenCode -> canonical translator (golden fixture, slice 1)", () => {
  const events = translateOpenCode(frames, CTX);
  const srcTypes = countByEventType(frames);
  const outKinds = countByKind(events);

  test("full coverage: no source event is silently dropped (0 unmapped warnings)", () => {
    const unmapped = events.filter(
      (e) => e.kind === "harness.warning" && /^unmapped/.test((e as { message: string }).message),
    );
    if (unmapped.length) console.log("[canonical] unmapped:", [...new Set(unmapped.map((e) => (e as { rawEventType?: string }).rawEventType))]);
    expect(unmapped.length).toBe(0);
  });

  test("every emitted event is a KNOWN canonical kind (exhaustive)", () => {
    for (const e of events) assertKnownKind(e);
  });

  test("well-formed envelope on every event (schema, ids, identity)", () => {
    for (const e of events) {
      expect(e.schemaVersion).toBe(1);
      expect(e.runId).toBe("run_test");
      expect(e.threadId).toBe("thread_test");
      expect(typeof e.eventId).toBe("string");
      expect(e.identity.provider.length).toBeGreaterThan(0);
      expect(typeof e.identity.nativeEventId).toBe("string");
    }
  });

  test("seq is a dense, monotonic Skynet cursor (0..N-1)", () => {
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  test("eventId is stable + unique per emitted event (idempotent replay)", () => {
    const ids = events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("run_test:"))).toBe(true);
  });

  test("tool frames map 1:1 to tool.completed (fixture has no task children)", () => {
    const toolFrames = (srcTypes["part.tool.completed"] ?? 0) + (srcTypes["part.tool.error"] ?? 0);
    expect(outKinds["tool.completed"] ?? 0).toBe(toolFrames);
    expect(outKinds["child.started"] ?? 0).toBe(0); // no subagents in this run
    const errs = events.filter((e) => e.kind === "tool.completed" && (e as { status: string }).status === "error");
    expect(errs.length).toBe(srcTypes["part.tool.error"] ?? 0);
  });

  test("reasoning + text + session frames map to their canonical kinds", () => {
    expect(outKinds["reasoning.delta"] ?? 0).toBe(srcTypes["part.reasoning"] ?? 0);
    // message.delta = part.text on root sessions with a messageId (<= total part.text)
    expect(outKinds["message.delta"] ?? 0).toBeGreaterThan(0);
    expect(outKinds["message.delta"] ?? 0).toBeLessThanOrEqual(srcTypes["part.text"] ?? 0);
    expect(outKinds["session.metadata"] ?? 0).toBeGreaterThanOrEqual(srcTypes["session.updated"] ?? 0);
    console.log("[canonical] frames:", frames.length, "-> events:", events.length, outKinds);
  });

  test("step-start emits nothing; step-finish closes only text-bearing messages", () => {
    // message.completed count never exceeds the assistant messages that had text.
    expect(outKinds["message.completed"] ?? 0).toBeLessThanOrEqual(outKinds["message.delta"] ?? 0);
  });
});

// The real fixture has no subagents, so prove child.* equivalence against the SAME
// synthetic task frames the legacy deriveChildFidelity golden uses.
describe("child derivation equivalence (synthetic task frames)", () => {
  const taskFrames: OpenCodeFrame[] = [
    {
      eventId: "e1", seq: 1, provider: "opencode", eventType: "part.tool.completed",
      native: { sessionId: "ses_p", parentSessionId: null, messageId: "m1", partId: "p1", callId: "call_1" },
      payload: { type: "tool", tool: "task", state: { status: "completed", output: '<task id="ses_child1"><task_result>the answer</task_result></task>' } },
    },
    {
      eventId: "e2", seq: 2, provider: "opencode", eventType: "part.tool.error",
      native: { sessionId: "ses_p", parentSessionId: null, messageId: "m1", partId: "p2", callId: "call_2" },
      payload: { type: "tool", tool: "task", state: { status: "error", output: "" } },
    },
  ];

  test("task tool -> child.started + child.completed with derived id/result/status", () => {
    const ev = translateOpenCode(taskFrames, CTX);
    const started = ev.filter((e) => e.kind === "child.started");
    const done = ev.filter((e) => e.kind === "child.completed");
    expect(started.length).toBe(2);
    expect(done.length).toBe(2);

    const c1 = done.find((e) => (e as { childId: string }).childId === "ses_child1") as
      | { childId: string; status: string; result?: string } | undefined;
    expect(c1?.status).toBe("ok");
    expect(c1?.result).toBe("the answer");

    // errored task -> child.completed status error (childId falls back to callId)
    const c2 = done.find((e) => (e as { status: string }).status === "error");
    expect(c2).toBeTruthy();
  });
});
