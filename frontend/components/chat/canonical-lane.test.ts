// Phase 1 slice-4 gate: the frontend canonical LANE. The thread store accumulates the
// SSE `canonical` events per run (latest revision per eventId wins, ordered by the
// immutable deliverySeq), and the reducer turns them into the timeline. Proves the
// wiring the flag-gated render path depends on; the reducer<->legacy equivalence is
// proven separately (canonical-timeline.equiv/.nodes tests).

import { describe, expect, test } from "bun:test";
import { createThreadStore } from "./thread-store";
import { buildTimelineFromCanonical, type StoredCanonicalEvent } from "./canonical-timeline";
import type { ApiRun, ApiStep } from "./types";

const RUN = "run_x";
const run: ApiRun = {
  id: RUN, prompt: "p", model: "m", engine: "opencode", status: "completed",
  summary: "s", steps: [], created_at: "", thread_id: RUN, parent_run_id: null,
} as unknown as ApiRun;

function ev(over: Partial<StoredCanonicalEvent> & { eventId: string; deliverySeq: number }): StoredCanonicalEvent {
  return {
    kind: "message.delta", seq: over.seq ?? 0, runId: RUN, revision: over.revision ?? 0,
    identity: over.identity ?? { nativeSessionId: "ses_root" },
    ...over,
  } as StoredCanonicalEvent;
}

describe("thread store canonical lane (slice 4)", () => {
  test("accumulates per-run canonical events, ordered by deliverySeq", () => {
    const store = createThreadStore();
    store.applySnapshot([run]);
    store.applyCanonical(ev({ eventId: "a", deliverySeq: 2, seq: 1 }));
    store.applyCanonical(ev({ eventId: "b", deliverySeq: 1, seq: 0 }));
    const view = store.getSnapshot().byId.get(RUN)!;
    expect(view.canonical.map((e) => e.eventId)).toEqual(["b", "a"]); // deliverySeq order
  });

  test("latest revision per eventId wins; a stale revision is ignored", () => {
    const store = createThreadStore();
    store.applySnapshot([run]);
    store.applyCanonical(ev({ eventId: "a", deliverySeq: 1, revision: 0, text: "v0" }));
    store.applyCanonical(ev({ eventId: "a", deliverySeq: 5, revision: 1, text: "v1" }));
    store.applyCanonical(ev({ eventId: "a", deliverySeq: 3, revision: 0, text: "stale" })); // older revision
    const view = store.getSnapshot().byId.get(RUN)!;
    expect(view.canonical.length).toBe(1);
    expect((view.canonical[0] as { text: string }).text).toBe("v1");
  });

  test("the accumulated lane feeds buildTimelineFromCanonical", () => {
    const store = createThreadStore();
    store.applySnapshot([run]);
    // A message.started (anchor) + a step-sourced tool.completed keyed to a step.
    store.applyCanonical(ev({ eventId: "ms", deliverySeq: 1, seq: 0, kind: "message.started", messageId: "m1", identity: { nativeSessionId: "ses_root", nativeSeq: 0, nativeMessageId: "m1" } } as never));
    store.applyCanonical(ev({ eventId: "tc", deliverySeq: 2, seq: 1, kind: "tool.completed", identity: { nativeEventId: "s0" } } as never));
    const view = store.getSnapshot().byId.get(RUN)!;
    const stepsById = new Map<string, ApiStep>([[
      "s0", { id: "s0", idx: 0, kind: "command", label: "bash", chip: null, code_json: JSON.stringify({ tool: "bash", type: "tool", native: { messageID: "m1", partID: "p", callID: "c" } }), created_at: "" } as unknown as ApiStep,
    ]]);
    const nodes = buildTimelineFromCanonical(view.canonical, stepsById, false);
    expect(nodes.length).toBe(1);
    expect(nodes[0].kind).toBe("tool");
    expect(nodes[0].key).toBe("s0");
  });
});

describe("thread store canonicalization-complete gate (H2)", () => {
  test("canonicalComplete defaults false and flips true only on markCanonicalComplete", () => {
    const store = createThreadStore();
    store.applySnapshot([run]);
    // Provisional canonical rows exist, but the run is NOT yet marked complete.
    store.applyCanonical(ev({ eventId: "a", deliverySeq: 1, seq: 0 }));
    expect(store.getSnapshot().byId.get(RUN)!.canonicalComplete).toBe(false);
    // The durable completion signal arrives -> the lane becomes trustworthy.
    store.markCanonicalComplete(RUN);
    expect(store.getSnapshot().byId.get(RUN)!.canonicalComplete).toBe(true);
  });

  test("markCanonicalComplete is idempotent (no snapshot churn on a repeat)", () => {
    const store = createThreadStore();
    store.applySnapshot([run]);
    store.markCanonicalComplete(RUN);
    const first = store.getSnapshot();
    store.markCanonicalComplete(RUN); // repeat
    expect(store.getSnapshot()).toBe(first); // same cached snapshot object - no rebuild
  });
});
