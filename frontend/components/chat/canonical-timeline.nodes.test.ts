// Phase 1 pre-React gate: prove canonical<->legacy timeline equivalence for the node
// types the protected 281-tool fixture does NOT exercise - assistant TEXT (single +
// multi message), skynet context MARKERS, and CHILD/subagent routing. Each scenario
// runs the SAME synthetic frames+steps through legacy buildTimeline and through
// translateOpenCode -> buildTimelineFromCanonical, and asserts identical (kind,key).

import { describe, expect, test } from "bun:test";
import { createNativeStore } from "./native-store";
import { buildTimeline, type TimelineNode } from "./timeline";
import { parseNativeFrame } from "./native-events";
import { buildTimelineFromCanonical, type CanonicalEventLike } from "./canonical-timeline";
import { translateOpenCode, type OpenCodeFrame, type OpenCodeStep } from "../../../backend/src/engines/opencode-canonical";
import type { ApiStep } from "./types";

type F = OpenCodeFrame;
type S = OpenCodeStep;
const ctx = { runId: "r", threadId: "r" };
const proj = (n: readonly TimelineNode[]) => n.map((x) => ({ kind: x.kind, key: x.key }));

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
    expect(JSON.stringify(proj(canon))).toBe(JSON.stringify(proj(legacy)));
  });

  test("skynet context markers lead the turn", () => {
    const frames: F[] = [
      frame({ eventType: "skill.loaded", seq: 0, provider: "skynet", native: {}, payload: { kind: "skill", name: "Deploy", version: 2, contentHash: "h" } }),
      frame({ eventType: "context.retrieved", seq: 1, provider: "skynet", native: {}, payload: { source: "memory", itemCount: 3 } }),
      frame({ eventType: "part.step-start", seq: 2, native: { messageId: "m1", partId: "ps1" } }),
      frame({ eventType: "part.tool.completed", seq: 3, native: { messageId: "m1", partId: "pc1", callId: "c1" }, payload: { type: "tool", tool: "bash" } }),
      frame({ eventType: "part.step-finish", seq: 4, native: { messageId: "m1", partId: "pf1" } }),
    ];
    const steps: S[] = [step("s1", 0, { sessionID: "ses_root", messageID: "m1", partID: "pc1", callID: "c1" })];
    const { legacy, canon } = bothWays(frames, steps);
    expect(legacy.filter((n) => n.kind === "marker").length).toBe(2);
    expect(legacy[0].kind).toBe("marker"); // markers lead
    expect(JSON.stringify(proj(canon))).toBe(JSON.stringify(proj(legacy)));
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
    expect(JSON.stringify(proj(canon))).toBe(JSON.stringify(proj(legacy)));
  });
});
