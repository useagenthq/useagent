// Phase 0 golden regression gate (final_harness.md): protect the OpenCode timeline
// + child derivation BEFORE the canonical translator / React rewiring. Feeds a
// sanitized, deterministic heavy-run fixture (1188 frames, zero customer data - see
// backend/scripts/extract-golden-fixture.ts) through the REAL native store and
// buildTimeline, and pins the derived structure + a performance budget. A change to
// timeline.ts that alters the OpenCode output must update this on purpose.

import { describe, expect, test } from "bun:test";
import heavy from "./__fixtures__/opencode-heavy.json";
import heavySteps from "./__fixtures__/opencode-heavy-steps.json";
import { createNativeStore } from "./native-store";
import { buildTimeline, type TimelineNode } from "./timeline";
import { deriveChildFidelity, parseNativeFrame, type NativeFrame } from "./native-events";
import type { ApiStep } from "./types";

// Build the snapshot through BOTH lanes exactly as production does: steps via
// ingest() (buildTimeline's tool rows) and native frames via ingestNative()
// (narration/markers/child derivation).
function snapshotFrom(rawFrames: unknown[], steps: readonly ApiStep[] = []) {
  const store = createNativeStore();
  store.ingestAll(steps, 0); // gen 0 = the store's initial generation
  for (const raw of rawFrames) {
    const f = parseNativeFrame(raw);
    if (f) store.ingestNative(f, 0);
  }
  return store.getSnapshot();
}

function countByKind(nodes: TimelineNode[]): Record<string, number> {
  const by: Record<string, number> = {};
  for (const n of nodes) by[n.kind] = (by[n.kind] ?? 0) + 1;
  return by;
}

// Full golden: both lanes (289 steps + 1188 frames), sanitized, zero customer data.
// buildTimeline draws TOOL rows from the steps lane (native.steps) and narration/
// markers from the frame lane; this pins the derived timeline shape, the tool-row
// count, determinism, and the heavy-replay perf budget. A change to timeline.ts that
// alters the OpenCode output must update the pinned numbers on purpose.
const frames = heavy as unknown[];
const steps = heavySteps as unknown as ApiStep[];

describe("OpenCode timeline golden (heavy sanitized fixture, both lanes)", () => {
  // Exact golden: pinned to the committed sanitized fixtures. A change here means
  // the OpenCode derivation output changed - update deliberately with golden review.
  const EXPECTED_NODES = 281;
  const EXPECTED_TOOL_ROWS = 281;

  test("derived node count is pinned", () => {
    const nodes = buildTimeline(snapshotFrom(frames, steps), false) ?? [];
    console.log("[golden] frames:", frames.length, "steps:", steps.length, "nodes:", nodes.length, countByKind(nodes));
    expect(nodes.length).toBe(EXPECTED_NODES);
  });

  test("tool rows derive from the steps lane (pinned count)", () => {
    const nodes = buildTimeline(snapshotFrom(frames, steps), false) ?? [];
    expect(nodes.filter((n) => n.kind === "tool").length).toBe(EXPECTED_TOOL_ROWS);
  });

  test("deterministic: same fixtures -> identical timeline", () => {
    expect(buildTimeline(snapshotFrom(frames, steps), false)).toEqual(
      buildTimeline(snapshotFrom(frames, steps), false),
    );
  });

  test("well-formed: every node has a string kind", () => {
    for (const n of buildTimeline(snapshotFrom(frames, steps), false) ?? []) {
      expect(typeof n.kind).toBe("string");
    }
  });

  test("PERF budget: ingest 289 steps + 1188 frames + build under 750ms", () => {
    const t0 = performance.now();
    const nodes = buildTimeline(snapshotFrom(frames, steps), false);
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
