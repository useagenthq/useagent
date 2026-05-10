// Phase 1 slice-2 GATE: byte-for-byte equivalence between the legacy timeline and
// the canonical path on the protected golden fixture. The backend OpenCode->canonical
// translator + the frontend canonical->timeline reducer must reproduce buildTimeline's
// node sequence EXACTLY (kind + key, in order). This is the gate that must be green
// before any React cutover.

import { describe, expect, test } from "bun:test";
import heavy from "../../../packages/agent-harness/test/fixtures/opencode-heavy.json";
import heavySteps from "../../../packages/agent-harness/test/fixtures/opencode-heavy-steps.json";
import { createNativeStore } from "./native-store";
import { buildTimeline, type TimelineNode } from "./timeline";
import { parseNativeFrame } from "./native-events";
import { buildTimelineFromCanonical } from "./canonical-timeline";
import type { ApiStep } from "./types";
// The translator + golden fixtures live in the shared, zero-dependency
// @skynet/agent-harness package (final_harness: backend translates each harness).
// The frontend imports the published translator here for the equivalence proof;
// it is pure so it resolves cleanly in the test runner.
import { translateOpenCode, type OpenCodeFrame, type OpenCodeStep } from "@skynet/agent-harness/opencode";

const frames = heavy as unknown[];
const steps = heavySteps as unknown as ApiStep[];

function snapshot() {
  const store = createNativeStore();
  store.ingestAll(steps, 0);
  for (const raw of frames) {
    const f = parseNativeFrame(raw);
    if (f) store.ingestNative(f, 0);
  }
  return store.getSnapshot();
}

const proj = (nodes: readonly TimelineNode[]) => nodes.map((n) => ({ kind: n.kind, key: n.key }));

describe("canonical timeline equivalence (protected golden fixture)", () => {
  const snap = snapshot();
  const legacy = buildTimeline(snap, false) ?? [];
  const stepsById = new Map(snap.steps.map((s) => [s.id, s]));
  const { events } = translateOpenCode(
    frames as unknown as OpenCodeFrame[],
    { runId: "run_equiv", threadId: "thread_equiv" },
    steps as unknown as OpenCodeStep[],
  );
  const canon = buildTimelineFromCanonical(events, stepsById, false);

  test("same node count (the protected 281)", () => {
    console.log("[equiv] legacy nodes:", legacy.length, "canonical nodes:", canon.length, "canonical events:", events.length);
    expect(canon.length).toBe(legacy.length);
  });

  test("BYTE-FOR-BYTE identical node sequence (kind + key, in order)", () => {
    expect(JSON.stringify(proj(canon))).toBe(JSON.stringify(proj(legacy)));
  });

  test("FULL deep node equality (every field, not only kind+key) (H3)", () => {
    // The whole node - kind, key, and body (step / text / marker) - must match the
    // legacy node exactly, so the canonical render is indistinguishable, not merely
    // aligned on identity.
    expect(canon).toEqual(legacy);
  });

  test("every canonical node is backed by the same ApiStep the legacy node used", () => {
    for (let i = 0; i < canon.length; i++) {
      expect((canon[i] as { step: ApiStep }).step.id).toBe((legacy[i] as { step: ApiStep }).step.id);
    }
  });
});
