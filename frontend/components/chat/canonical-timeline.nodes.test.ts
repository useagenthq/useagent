// Phase 1 pre-React gate: prove canonical<->legacy timeline equivalence for the node
// types the protected 281-tool fixture does NOT exercise - assistant TEXT (single +
// multi message), skynet context MARKERS, and CHILD/subagent routing. Each scenario
// runs the SAME synthetic frames+steps through legacy buildTimeline and through
// translateOpenCode -> buildTimelineFromCanonical, and asserts identical (kind,key).

import { describe, expect, test } from "bun:test";
import { createNativeStore } from "./native-store";
import { buildTimeline } from "./timeline";
import { parseNativeFrame } from "./native-events";
import { buildTimelineFromCanonical, type CanonicalEventLike } from "./canonical-timeline";
import { translateOpenCode, type OpenCodeFrame, type OpenCodeStep } from "@skynet/agent-harness/opencode";
import type { ApiStep } from "./types";

type F = OpenCodeFrame;
type S = OpenCodeStep;
const ctx = { runId: "r", threadId: "r" };

function frame(over: Partial<F> & { eventType: string; seq: number }): F {
  return {
    eventId: over.eventId ?? `e${over.seq}`,
    seq: over.seq,
    provider: over.provider ?? "opencode",
    eventType: over.eventType,
    native: { sessionId: "ses_root", parentSessionId: null, messageId: null, partId: null, callId: null, ...(over.native ?? {}) },
    payload: over.payload ?? {},
  };
}
function step(id: string, idx: number, native: Record<string, string>, kind = "command"): S {
  return { id, idx, kind, code_json: JSON.stringify({ tool: "bash", type: "tool", native }) };
}

function snapshot(frames: F[], steps: S[]) {
  const st = createNativeStore();
  st.ingestAll(steps as unknown as ApiStep[], 0);
  for (const raw of frames) {
    const f = parseNativeFrame(raw);
    if (f) st.ingestNative(f, 0);
  }
  return st.getSnapshot();
}

function bothWays(frames: F[], steps: S[]) {
  const snap = snapshot(frames, steps);
  const legacy = buildTimeline(snap, false) ?? [];
  const stepsById = new Map(snap.steps.map((s) => [s.id, s]));
  const { events } = translateOpenCode(frames, ctx, steps);
  const canon = buildTimelineFromCanonical(events as unknown as CanonicalEventLike[], stepsById, false);
  return { legacy, canon };
}

describe("canonical<->legacy node equivalence (synthetic text / markers / child)", () => {
  test("assistant text interleaves with tools across TWO messages", () => {
    const frames: F[] = [
      frame({ eventType: "part.step-start", seq: 0, native: { messageId: "m1", partId: "ps1" } }),
      frame({ eventType: "part.text", seq: 1, native: { messageId: "m1", partId: "pt1" }, payload: { text: "first" } }),
      frame({ eventType: "part.tool.completed", seq: 2, native: { messageId: "m1", partId: "pc1", callId: "c1" }, payload: { type: "tool", tool: "bash" } }),
      frame({ eventType: "part.step-finish", seq: 3, native: { messageId: "m1", partId: "pf1" } }),
      frame({ eventType: "part.step-start", seq: 4, native: { messageId: "m2", partId: "ps2" } }),
      frame({ eventType: "part.text", seq: 5, native: { messageId: "m2", partId: "pt2" }, payload: { text: "second" } }),
      frame({ eventType: "part.tool.completed", seq: 6, native: { messageId: "m2", partId: "pc2", callId: "c2" }, payload: { type: "tool", tool: "bash" } }),
      frame({ eventType: "part.step-finish", seq: 7, native: { messageId: "m2", partId: "pf2" } }),
    ];
    const steps: S[] = [
      step("s1", 0, { sessionID: "ses_root", messageID: "m1", partID: "pc1", callID: "c1" }),
      step("s2", 1, { sessionID: "ses_root", messageID: "m2", partID: "pc2", callID: "c2" }),
    ];
    const { legacy, canon } = bothWays(frames, steps);
    expect(legacy.filter((n) => n.kind === "text").length).toBe(2); // scenario is non-vacuous
    expect(legacy.filter((n) => n.kind === "tool").length).toBe(2);
    expect(canon).toEqual(legacy); // FULL deep equality (H3), not only kind+key
  });

  test("skynet context markers lead the turn - FULL marker fidelity (every marker kind)", () => {
    // Exercise EVERY TimelineMarker variant the skynet lane can emit, each with its full
    // field set (version/hash, source/itemCount/query, op/scope/failed/reconciled,
    // deadlineMs), and assert the canonical marker node is DEEP-EQUAL to legacy - proving
    // the reconstruction is lossless, never fabricated (H3, review issue #5).
    const frames: F[] = [
      frame({ eventType: "skill.loaded", seq: 0, provider: "skynet", native: {}, payload: { kind: "playbook", name: "Deploy", version: 7, contentHash: "abc123" } }),
      frame({ eventType: "context.retrieved", seq: 1, provider: "skynet", native: {}, payload: { source: "memory", itemCount: 3, query: "how to deploy" } }),
      frame({ eventType: "knowledge.retrieved", seq: 2, provider: "skynet-knowledge", native: {}, payload: { itemCount: 5 } }),
      frame({ eventType: "memory.l0_accepted", seq: 3, provider: "skynet-memory", native: {}, payload: { op: "remember", scope: "personal", reconciled: true } }),
      frame({ eventType: "memory.failed", seq: 4, provider: "skynet-memory", native: {}, payload: { op: "correct", scope: "org" } }),
      frame({ eventType: "run.reconciling", seq: 5, provider: "skynet", native: {}, payload: { reason: "boot-restart", sinceMs: 1000, deadlineMs: 9999 } }),
      frame({ eventType: "part.step-start", seq: 6, native: { messageId: "m1", partId: "ps1" } }),
      frame({ eventType: "part.tool.completed", seq: 7, native: { messageId: "m1", partId: "pc1", callId: "c1" }, payload: { type: "tool", tool: "bash" } }),
      frame({ eventType: "part.step-finish", seq: 8, native: { messageId: "m1", partId: "pf1" } }),
    ];
    const steps: S[] = [step("s1", 0, { sessionID: "ses_root", messageID: "m1", partID: "pc1", callID: "c1" })];
    const { legacy, canon } = bothWays(frames, steps);
    expect(legacy.filter((n) => n.kind === "marker").length).toBe(6); // all six markers rendered
    expect(legacy[0].kind).toBe("marker"); // markers lead
    // The exact typed marker bodies (skill playbook+version+hash, context+query, memory
    // op+scope+reconciled, reconciling+deadline) must round-trip.
    expect(canon).toEqual(legacy);
  });

  test("child/subagent text is routed OUT of the main timeline (only the parent tool row remains)", () => {
    const frames: F[] = [
      frame({ eventType: "part.step-start", seq: 0, native: { messageId: "m1", partId: "ps1" } }),
      frame({ eventType: "part.tool.completed", seq: 1, native: { messageId: "m1", partId: "pc1", callId: "c1" }, payload: { type: "tool", tool: "task", state: { status: "completed", output: '<task id="ses_child"></task>' } } }),
      // child session parts (parentSessionId set) - must NOT appear in the main timeline
      frame({ eventType: "part.step-start", seq: 2, native: { sessionId: "ses_child", parentSessionId: "ses_root", messageId: "cm1", partId: "cps1" } }),
      frame({ eventType: "part.text", seq: 3, native: { sessionId: "ses_child", parentSessionId: "ses_root", messageId: "cm1", partId: "cpt1" }, payload: { text: "child chatter" } }),
      frame({ eventType: "part.step-finish", seq: 4, native: { messageId: "m1", partId: "pf1" } }),
    ];
    const steps: S[] = [step("s1", 0, { sessionID: "ses_root", messageID: "m1", partID: "pc1", callID: "c1" }, "command")];
    const { legacy, canon } = bothWays(frames, steps);
    expect(legacy.some((n) => n.kind === "text")).toBe(false); // child text excluded
    expect(canon).toEqual(legacy); // FULL deep equality (H3)
  });
});
