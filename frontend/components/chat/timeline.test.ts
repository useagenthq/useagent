// Ordering + attribution tests for the interleaved turn timeline.
// Run: `bun test components/chat/timeline.test.ts` (from frontend/).

import { describe, expect, test } from "bun:test";
import { buildTimeline, deriveTurnSources, hasNarration, parseFollowups } from "./timeline";
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

// useAgent-lane context markers (skill.loaded / context.retrieved) share the frame()
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

  test("an UNKNOWN useAgent eventType is ignored (renders safely as nothing)", () => {
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

// Memory tool chips (provider "skynet-memory", frozen contract in
// backend/src/knowledge/gateway/memory-tools.ts MEMORY_EVENTS).
function memoryFrame(eventId: string, seq: number, eventType: string, payload: unknown): NativeFrame {
  return { ...frame(eventId, seq, eventType, {}, payload), provider: "skynet-memory" };
}

describe("memory tool markers", () => {
  test("memory.searched joins the context grammar (Recalled N items from memory)", () => {
    const s = createNativeStore();
    s.reset([], 0);
    s.ingestNative(
      memoryFrame("ms_1", 0, "memory.searched", {
        source: "memory",
        query: "deploy region",
        scope: "org",
        itemCount: 2,
        latencyMs: 3,
        refs: ["tencent:l0:a", "tencent:l1:b"],
      }),
      0,
    );
    expect(buildTimeline(s.getSnapshot(), false)![0]).toMatchObject({
      kind: "marker",
      marker: { kind: "context", source: "memory", itemCount: 2, query: "deploy region" },
    });
  });

  test("l0_accepted / updated / deleted map to remember / correct / forget chips with scope", () => {
    const s = createNativeStore();
    s.reset([], 0);
    s.ingestNative(
      memoryFrame("ml0_1", 0, "memory.l0_accepted", {
        source: "memory",
        op: "remember",
        scope: "org",
        reconciled: false,
        operationId: "op1",
        refs: ["tencent:l0:x"],
        content: "fact",
      }),
      0,
    );
    s.ingestNative(
      memoryFrame("mu_1", 1, "memory.updated", { source: "memory", op: "correct", scope: "personal", ref: "tencent:l1:y" }),
      0,
    );
    s.ingestNative(
      memoryFrame("md_1", 2, "memory.deleted", { source: "memory", op: "forget", scope: "org", ref: "tencent:l1:z", removed: 1 }),
      0,
    );
    const markers = buildTimeline(s.getSnapshot(), false)!.map((n) => (n.kind === "marker" ? n.marker : null));
    expect(markers[0]).toMatchObject({ kind: "memory", op: "remember", scope: "org", failed: false, reconciled: false });
    expect(markers[1]).toMatchObject({ kind: "memory", op: "correct", scope: "personal", failed: false });
    expect(markers[2]).toMatchObject({ kind: "memory", op: "forget", scope: "org", failed: false });
  });

  test("a reconciled l0_accepted flags the idempotent no-op replay", () => {
    const s = createNativeStore();
    s.reset([], 0);
    s.ingestNative(
      memoryFrame("ml0_1", 0, "memory.l0_accepted", { source: "memory", op: "remember", scope: "org", reconciled: true, operationId: "op1", refs: [] }),
      0,
    );
    expect(buildTimeline(s.getSnapshot(), false)![0]).toMatchObject({
      marker: { kind: "memory", op: "remember", reconciled: true },
    });
  });

  test("memory.failed keeps the failing op and never renders as a success chip", () => {
    const s = createNativeStore();
    s.reset([], 0);
    s.ingestNative(
      memoryFrame("mf_1", 0, "memory.failed", { source: "memory", op: "forget", scope: "org", reason: "fail_closed", removed: 0 }),
      0,
    );
    expect(buildTimeline(s.getSnapshot(), false)![0]).toMatchObject({
      marker: { kind: "memory", op: "forget", failed: true },
    });
  });

  test("memory.l1_indexed (defined upstream but unused) is ignored safely", () => {
    const s = createNativeStore();
    s.reset([], 0);
    s.ingestNative(memoryFrame("ml1_1", 0, "memory.l1_indexed", { source: "memory" }), 0);
    expect(buildTimeline(s.getSnapshot(), false)!.some((n) => n.kind === "marker")).toBe(false);
  });
});

describe("memory read-outage chip (memory.failed op:search)", () => {
  test("a search outage renders as a failed memory marker, never a 0-hit context row", () => {
    const s = createNativeStore();
    s.reset([], 0);
    s.ingestNative(
      memoryFrame("mfs_1", 0, "memory.failed", { source: "memory", op: "search", scope: "org", reason: "unavailable" }),
      0,
    );
    expect(buildTimeline(s.getSnapshot(), false)![0]).toMatchObject({
      marker: { kind: "memory", op: "search", failed: true },
    });
  });
});

describe("run.reconciling marker (adaptive re-probe park)", () => {
  test("renders as a reconciling marker with the deadline", () => {
    const s = createNativeStore();
    s.reset([], 0);
    s.ingestNative(
      skynetFrame("rec_1", 0, "run.reconciling", { reason: "boot-restart", sinceMs: 1000, deadlineMs: 301000 }),
      0,
    );
    expect(buildTimeline(s.getSnapshot(), false)![0]).toMatchObject({
      kind: "marker",
      marker: { kind: "reconciling", deadlineMs: 301000 },
    });
  });

  test("legacy ISO-deadline payload still parses safely (deadlineMs null)", () => {
    const s = createNativeStore();
    s.reset([], 0);
    s.ingestNative(skynetFrame("rec_2", 0, "run.reconciling", { reason: "boot-restart", deadline: "2026-08-06T14:00:00Z" }), 0);
    expect(buildTimeline(s.getSnapshot(), false)![0]).toMatchObject({
      marker: { kind: "reconciling", deadlineMs: null },
    });
  });
});

describe("follow-ups + turn sources (beautiful-ui answer grammar)", () => {
  test("a followups.suggested frame becomes the turn's CLOSING node (after artifacts)", () => {
    const s = turnStore();
    s.ingestNative(
      skynetFrame("art_1", 70, "artifact.created", {
        id: "a1",
        name: "report.pdf",
        size_bytes: 10,
        sha256: "x".repeat(64),
        content_type: "application/pdf",
      }),
      0,
    );
    s.ingestNative(
      skynetFrame("folup_run-1", 71, "followups.suggested", {
        suggestions: ["Scale per plan tier?", "Add a Retry-After test"],
      }),
      0,
    );
    const nodes = buildTimeline(s.getSnapshot(), false)!;
    const last = nodes.at(-1)!;
    expect(last).toMatchObject({
      kind: "followups",
      suggestions: ["Scale per plan tier?", "Add a Retry-After test"],
    });
    expect(nodes.at(-2)!.kind).toBe("artifact");
  });

  test("parseFollowups rejects other event types and malformed payloads", () => {
    expect(parseFollowups("context.retrieved", { suggestions: ["x"] })).toBeNull();
    expect(parseFollowups("followups.suggested", { suggestions: [] })).toBeNull();
    expect(parseFollowups("followups.suggested", { suggestions: [1, "  "] })).toBeNull();
    expect(parseFollowups("followups.suggested", null)).toBeNull();
    expect(parseFollowups("followups.suggested", { suggestions: ["ok?"] })).toEqual(["ok?"]);
  });

  test("deriveTurnSources reads fetch-tool URLs, one entry per domain, www stripped", () => {
    const fetchNode = (idx: number, url: string, error = false) => ({
      kind: "tool" as const,
      key: `f${idx}`,
      step: step(idx, "command", "fetch", { tool: "webfetch", input: { url }, error }),
    });
    const searchNode = {
      kind: "tool" as const,
      key: "srch",
      step: step(9, "command", "search", { tool: "websearch", input: { query: "rate limits" } }),
    };
    const sources = deriveTurnSources([
      fetchNode(0, "https://www.hono.dev/docs/middleware"),
      fetchNode(1, "https://hono.dev/docs/other"),
      fetchNode(2, "https://redis.io/commands/incr"),
      fetchNode(3, "https://failed.example/internal", true),
      fetchNode(4, "ftp://files.example/archive"),
      searchNode,
    ]);
    expect(sources).toEqual([
      { domain: "hono.dev", href: "https://www.hono.dev/docs/middleware" },
      { domain: "redis.io", href: "https://redis.io/commands/incr" },
    ]);
  });
});
