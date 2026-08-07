// Phase 0 golden regression gate (final_harness.md): protect the OpenCode timeline
// + child derivation BEFORE the canonical translator / React rewiring. Feeds a
// sanitized, deterministic heavy-run fixture (1188 frames, zero customer data - see
// backend/scripts/extract-golden-fixture.ts) through the REAL native store and
// buildTimeline, and pins the derived structure + a performance budget. A change to
// timeline.ts that alters the OpenCode output must update this on purpose.

import { describe, expect, test } from "bun:test";
import heavy from "./__fixtures__/opencode-heavy.json";
import { createNativeStore } from "./native-store";
import { buildTimeline, type TimelineNode } from "./timeline";
import { deriveChildFidelity, parseNativeFrame, type NativeFrame } from "./native-events";

function snapshotFrom(rawFrames: unknown[]) {
  const store = createNativeStore();
  for (const raw of rawFrames) {
    const f = parseNativeFrame(raw);
    if (f) store.ingestNative(f, 0); // gen 0 = the store's initial generation
  }
  return store.getSnapshot();
}

function countByKind(nodes: TimelineNode[]): Record<string, number> {
  const by: Record<string, number> = {};
  for (const n of nodes) by[n.kind] = (by[n.kind] ?? 0) + 1;
  return by;
}

// NOTE: buildTimeline draws TOOL rows and narration from the STEPS lane
// (native.steps, populated via store.ingest of ApiSteps) as well as native frames.
// This fixture captures the provider_events (native-frame) lane only, so it locks
// the frame-processing path - markers, text-frame classification, determinism, and
// the heavy-replay perf budget - and is a no-throw/regression guard on real-shaped
// input. Node-level golden output (tool rows) needs the sanitized steps lane, the
// next extractor extension (#123). Child derivation below is fully frame-based and
// is pinned exactly.
describe("OpenCode timeline frame-lane golden (heavy sanitized fixture)", () => {
  test("runs on 1188 real-shaped frames without throwing; returns an array", () => {
    const snap = snapshotFrom(heavy as unknown[]);
    const nodes = buildTimeline(snap, false) ?? [];
    console.log("[golden] frames:", (heavy as unknown[]).length, "nodes:", nodes.length, countByKind(nodes));
    expect(Array.isArray(nodes)).toBe(true);
    expect(snap.nativeFrames.length).toBe((heavy as unknown[]).length);
  });

  test("deterministic: same fixture -> identical timeline", () => {
    const a = buildTimeline(snapshotFrom(heavy as unknown[]), false);
    const b = buildTimeline(snapshotFrom(heavy as unknown[]), false);
    expect(a).toEqual(b);
  });

  test("well-formed: every node has a kind, no undefined leaks", () => {
    const nodes = buildTimeline(snapshotFrom(heavy as unknown[]), false) ?? [];
    for (const n of nodes) expect(typeof n.kind).toBe("string");
  });

  test("PERF budget: ingest 1188 frames + build under 750ms", () => {
    const t0 = performance.now();
    const nodes = buildTimeline(snapshotFrom(heavy as unknown[]), false);
    const ms = performance.now() - t0;
    console.log(`[golden] ingest+build wall: ${ms.toFixed(0)}ms`);
    expect(nodes).not.toBeNull();
    expect(ms).toBeLessThan(750);
  });
});

// The heavy run had no subagents, so cover child derivation with synthetic task
// frames (the branch buildTimeline/agents-rail depend on).
const taskFrame = (over: Partial<NativeFrame> & { payload?: unknown }): unknown => ({
  schemaVersion: 1,
  eventId: `e_${Math.round((over.seq ?? 0) * 1)}`,
  seq: over.seq ?? 0,
  provider: "opencode",
  eventType: over.eventType ?? "part.tool.completed",
  native: { sessionId: "ses_p", parentSessionId: null, messageId: "m1", partId: "p1", callId: over.native?.callId ?? "call_x", ...(over.native ?? {}) },
  payload: over.payload,
});

describe("child derivation golden (synthetic task frames)", () => {
  test("derives child session id + result + completed status from a task tool", () => {
    const frames = [
      taskFrame({
        seq: 1,
        eventType: "part.tool.completed",
        native: { callId: "call_1" } as NativeFrame["native"],
        payload: {
          type: "tool",
          tool: "task",
          state: { status: "completed", output: '<task id="ses_child1"><task_result>the answer</task_result></task>' },
        },
      }),
    ].map((r) => parseNativeFrame(r)).filter((f): f is NativeFrame => f !== null);

    const fidelity = deriveChildFidelity(frames);
    const child = fidelity.get("call_1");
    expect(child?.childSessionId).toBe("ses_child1");
    expect(child?.status).toBe("completed");
    expect(child?.resultText).toBe("the answer");
  });

  test("a task tool ending in error derives failed status", () => {
    const frames = [
      taskFrame({
        seq: 1,
        eventType: "part.tool.error",
        native: { callId: "call_2" } as NativeFrame["native"],
        payload: { type: "tool", tool: "task", state: { status: "error", output: "" } },
      }),
    ].map((r) => parseNativeFrame(r)).filter((f): f is NativeFrame => f !== null);

    expect(deriveChildFidelity(frames).get("call_2")?.status).toBe("failed");
  });
});
