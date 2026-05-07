// Ordering + attribution tests for the interleaved turn timeline.
// Run: `bun test components/chat/timeline.test.ts` (from frontend/).

import { describe, expect, test } from "bun:test";
import { buildTimeline, hasNarration } from "./timeline";
import { createNativeStore } from "./native-store";
import type { NativeFrame } from "./native-events";
import type { ApiStep, StepKind } from "./types";

type Ids = Partial<NativeFrame["native"]>;
function frame(
  eventId: string,
  seq: number,
  eventType: string,
  ids: Ids,
  payload: unknown = {},
): NativeFrame {
  return {
    schemaVersion: 1,
    eventId,
    seq,
    provider: "opencode",
    eventType,
    native: {
      sessionId: ids.sessionId ?? null,
      parentSessionId: ids.parentSessionId ?? null,
      messageId: ids.messageId ?? null,
      partId: ids.partId ?? null,
      callId: ids.callId ?? null,
    },
    payload,
  };
}

let uid = 0;
function step(
  idx: number,
  kind: StepKind,
  label: string,
  code: Record<string, unknown> | null,
  chip: string | null = null,
): ApiStep {
  return {
    id: `st_${uid++}`,
    run_id: "run-1",
    idx,
    kind,
    label,
    chip,
    code_json: code ? JSON.stringify(code) : null,
    created_at: new Date(0).toISOString(),
  };
}
const toolStep = (idx: number, name: string, partID: string, messageID: string, sessionID = "root") =>
  step(idx, "command", name, { tool: name, input: { command: name }, native: { sessionID, messageID, partID, callID: `call_${partID}` } });

/** A two-step turn: each step = one message (step-start → narration text → tool),
 *  plus injected context text, a child subagent's chatter, a synthetic summary
 *  pseudo-step, and a boot row. The tool completion frames carry a FAR-HIGHER seq
 *  than the later step's text (the real upsert-to-completion behaviour). */
function turnStore() {
  const s = createNativeStore();
  s.reset(
    [
      toolStep(0, "bash", "m1x", "m1"),
      toolStep(1, "read", "m2x", "m2"),
      // Synthetic final-answer step (chip "task") — must NOT double as a tool row.
      step(2, "task", "Second burst.", null, "task"),
      // Sandbox boot row — live only.
      step(3, "task", "Sandbox — booting", null, "opencode"),
    ],
    0,
  );
  const frames: NativeFrame[] = [
    frame("pe_ctx", 0, "part.text", { sessionId: "root", messageId: "mc", partId: "pc" }, { text: "TEAM MEMORY CONTEXT" }),
    frame("pe_m1ss", 1, "part.step-start", { sessionId: "root", messageId: "m1", partId: "m1ss" }, { type: "step-start" }),
    frame("pe_m1t", 2, "part.text", { sessionId: "root", messageId: "m1", partId: "m1t" }, { text: "First burst." }),
    frame("pe_m1x", 60, "part.tool.completed", { sessionId: "root", messageId: "m1", partId: "m1x", callId: "call_m1x" }, { type: "tool", tool: "bash", state: { status: "completed" } }),
    frame("pe_m2ss", 3, "part.step-start", { sessionId: "root", messageId: "m2", partId: "m2ss" }, { type: "step-start" }),
    frame("pe_m2t", 4, "part.text", { sessionId: "root", messageId: "m2", partId: "m2t" }, { text: "Second burst." }),
    frame("pe_m2x", 61, "part.tool.completed", { sessionId: "root", messageId: "m2", partId: "m2x", callId: "call_m2x" }, { type: "tool", tool: "read", state: { status: "completed" } }),
    // Child subagent: a lifecycle frame establishes parentage, its text is chatter.
    frame("pe_chlife", 40, "session.updated", { sessionId: "child", parentSessionId: "root" }, {}),
    frame("pe_cht", 41, "part.text", { sessionId: "child", messageId: "cm", partId: "cpt" }, { text: "CHILD CHATTER" }),
  ];
  for (const f of frames) s.ingestNative(f, 0);
  return s;
}

describe("buildTimeline", () => {
  test("interleaves narration bursts with the tools that followed them, in true order", () => {
    const nodes = buildTimeline(turnStore().getSnapshot(), false)!;
    const shape = nodes.map((n) => (n.kind === "text" ? `T:${n.text}` : `X:${n.step.label}`));
    expect(shape).toEqual(["T:First burst.", "X:bash", "T:Second burst.", "X:read"]);
  });

  test("message-anchored order survives the tool completion seq bump (no raw-seq scramble)", () => {
    // bash/read complete at seq 60/61 — far after m2's text (seq 4). Raw-seq order
    // would push both tools to the end; message-anchoring keeps bash before text 2.
    const nodes = buildTimeline(turnStore().getSnapshot(), false)!;
    const bash = nodes.findIndex((n) => n.kind === "tool" && n.step.label === "bash");
    const text2 = nodes.findIndex((n) => n.kind === "text" && n.text === "Second burst.");
    expect(bash).toBeLessThan(text2);
  });

  test("excludes injected context text and child subagent chatter", () => {
    const texts = buildTimeline(turnStore().getSnapshot(), false)!
      .filter((n) => n.kind === "text")
      .map((n) => (n as { text: string }).text);
    expect(texts).toEqual(["First burst.", "Second burst."]);
    expect(texts).not.toContain("TEAM MEMORY CONTEXT");
    expect(texts).not.toContain("CHILD CHATTER");
  });

  test("drops the synthetic final-answer step (text frames already render it)", () => {
    const tools = buildTimeline(turnStore().getSnapshot(), false)!.filter((n) => n.kind === "tool");
    expect(tools.map((n) => (n as { step: ApiStep }).step.label)).toEqual(["bash", "read"]);
  });

  test("keeps boot rows while live, drops them once settled", () => {
    const live = buildTimeline(turnStore().getSnapshot(), true)!;
    expect(live[0]).toMatchObject({ kind: "tool" });
    expect((live[0] as { step: ApiStep }).step.label).toBe("Sandbox — booting");
    const settled = buildTimeline(turnStore().getSnapshot(), false)!;
    expect(settled.some((n) => n.kind === "tool" && n.step.label === "Sandbox — booting")).toBe(false);
  });

  test("returns null when the run carries no native frames (caller falls back)", () => {
    const s = createNativeStore();
    s.reset([toolStep(0, "bash", "m1x", "m1")], 0);
    expect(buildTimeline(s.getSnapshot(), true)).toBeNull();
  });

  test("hasNarration reflects whether any narration burst survived", () => {
    expect(hasNarration(buildTimeline(turnStore().getSnapshot(), false)!)).toBe(true);
    const s = createNativeStore();
    s.reset([toolStep(0, "bash", "m1x", "m1")], 0);
    s.ingestNative(frame("pe_m1x", 60, "part.tool.completed", { sessionId: "root", messageId: "m1", partId: "m1x" }, { type: "tool", tool: "bash" }), 0);
    expect(hasNarration(buildTimeline(s.getSnapshot(), false)!)).toBe(false);
  });
});

// Skynet-lane context markers (skill.loaded / context.retrieved) share the frame()
// helper but override provider to "skynet".
function skynetFrame(eventId: string, seq: number, eventType: string, payload: unknown): NativeFrame {
  return { ...frame(eventId, seq, eventType, {}, payload), provider: "skynet" };
}

describe("canonical context markers", () => {
  test("skill.loaded + context.retrieved render as the turn's LEADING marker rows", () => {
    const s = turnStore();
    s.ingestNative(
      skynetFrame("skillloaded_run-1", 0, "skill.loaded", {
        skillId: "sk1",
        version: 2,
        name: "Haiku answers",
        contentHash: "abc123",
        source: "skill",
        contentChars: 120,
      }),
      0,
    );
    s.ingestNative(
      skynetFrame("ctxret_run-1", 1, "context.retrieved", { source: "memory", itemCount: 3, query: "q" }),
      0,
    );
    const nodes = buildTimeline(s.getSnapshot(), false)!;
    // Markers lead, in seq order (skill.loaded seq 0 → context.retrieved seq 1).
    expect(nodes[0]).toMatchObject({ kind: "marker", marker: { kind: "skill", name: "Haiku answers", version: 2 } });
    expect(nodes[1]).toMatchObject({ kind: "marker", marker: { kind: "context", source: "memory", itemCount: 3 } });
    // Narration/tools still follow.
    expect(nodes.slice(2).some((n) => n.kind === "text" && n.text === "First burst.")).toBe(true);
  });

  test("a playbook skill.loaded frame flags the marker as a playbook; a plain skill does not", () => {
    const pb = turnStore();
    pb.ingestNative(
      skynetFrame("skillloaded_run-1", 0, "skill.loaded", {
        skillId: "pb1",
        version: 1,
        kind: "playbook",
        name: "Triage escalation",
        contentHash: "def456",
        source: "skill",
        contentChars: 200,
      }),
      0,
    );
    expect(buildTimeline(pb.getSnapshot(), false)![0]).toMatchObject({
      marker: { kind: "skill", playbook: true, name: "Triage escalation" },
    });

    // A frame without kind (or a plain skill) defaults to playbook:false.
    const sk = turnStore();
    sk.ingestNative(
      skynetFrame("skillloaded_run-1", 0, "skill.loaded", {
        skillId: "sk1",
        version: 1,
        name: "Answer in haiku",
        contentHash: "abc",
        source: "skill",
        contentChars: 40,
      }),
      0,
    );
    expect(buildTimeline(sk.getSnapshot(), false)![0]).toMatchObject({
      marker: { kind: "skill", playbook: false },
    });
  });

  test("an UNKNOWN skynet eventType is ignored (renders safely as nothing)", () => {
    const s = turnStore();
    s.ingestNative(skynetFrame("weird_run-1", 0, "policy.denied.future", { foo: 1 }), 0);
    expect(buildTimeline(s.getSnapshot(), false)!.some((n) => n.kind === "marker")).toBe(false);
  });

  test("context.retrieved defaults its source to memory; a knowledge source is preserved", () => {
    const mem = createNativeStore();
    mem.reset([], 0);
    mem.ingestNative(skynetFrame("ctxret_run-1", 0, "context.retrieved", { itemCount: 1 }), 0);
    mem.ingestNative(skynetFrame("kn_run-1", 1, "context.retrieved", { source: "knowledge", itemCount: 2 }), 0);
    const markers = buildTimeline(mem.getSnapshot(), false)!.filter((n) => n.kind === "marker");
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ marker: { source: "memory", itemCount: 1 } });
    expect(markers[1]).toMatchObject({ marker: { source: "knowledge", itemCount: 2 } });
  });
});
