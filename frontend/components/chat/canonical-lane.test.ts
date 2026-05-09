// Phase 1 slice-4 gate: the frontend canonical LANE. The thread store accumulates the
// SSE `canonical` events per run (latest revision per eventId wins, ordered by the
// immutable deliverySeq), and the reducer turns them into the timeline. Proves the
// wiring the flag-gated render path depends on; the reducer<->legacy equivalence is
// proven separately (canonical-timeline.equiv/.nodes tests).

import { describe, expect, test } from "bun:test";
import { createThreadStore } from "./thread-store";
import {
  buildTimelineFromCanonical,
  shouldUseCanonicalTimeline,
  validateCanonicalComplete,
  validateCanonicalEvent,
  type StoredCanonicalEvent,
} from "./canonical-timeline";
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

describe("canonical SSE frame validation (H4 - issue #6)", () => {
  const THREAD = "thread_v";
  const valid = (): Record<string, unknown> => ({
    schemaVersion: 1, kind: "message.delta", seq: 3, runId: "run_v", threadId: THREAD,
    eventId: "e1", deliverySeq: 5, revision: 0, identity: { nativeSessionId: "ses_root" }, text: "hi",
  });

  test("accepts a well-formed event and returns it typed", () => {
    const e = validateCanonicalEvent(valid(), THREAD);
    expect(e).not.toBeNull();
    expect(e!.eventId).toBe("e1");
    expect(e!.deliverySeq).toBe(5);
  });

  test("rejects non-objects and every missing/ill-typed envelope field", () => {
    expect(validateCanonicalEvent(null, THREAD)).toBeNull();
    expect(validateCanonicalEvent("nope", THREAD)).toBeNull();
    const bad: Array<Partial<Record<string, unknown>>> = [
      { schemaVersion: 2 },            // unknown schema version
      { schemaVersion: undefined },    // missing schema version
      { kind: "" },                    // empty kind
      { kind: 5 },                     // non-string kind
      { eventId: "" },                 // empty eventId
      { runId: undefined },            // missing runId
      { threadId: "" },                // empty threadId
      { seq: "3" },                    // non-numeric seq
      { seq: NaN },                    // NaN seq (would corrupt ordering)
      { deliverySeq: 0 },              // deliverySeq must be >= 1
      { deliverySeq: undefined },      // missing deliverySeq (would corrupt dedupe)
      { revision: -1 },                // negative revision
      { identity: "x" },               // identity must be an object when present
    ];
    for (const patch of bad) {
      expect(validateCanonicalEvent({ ...valid(), ...patch }, THREAD)).toBeNull();
    }
  });

  test("rejects a frame whose event names a DIFFERENT thread than its envelope", () => {
    expect(validateCanonicalEvent({ ...valid(), threadId: "thread_other" }, THREAD)).toBeNull();
  });

  test("identity may be absent (optional)", () => {
    const e = { ...valid() };
    delete e.identity;
    expect(validateCanonicalEvent(e, THREAD)).not.toBeNull();
  });

  test("validateCanonicalComplete: needs a runId, rejects a cross-thread payload", () => {
    expect(validateCanonicalComplete({ runId: "run_v", threadId: THREAD }, THREAD)).toEqual({ runId: "run_v" });
    expect(validateCanonicalComplete({ runId: "" }, THREAD)).toBeNull();
    expect(validateCanonicalComplete(null, THREAD)).toBeNull();
    expect(validateCanonicalComplete({ runId: "run_v", threadId: "thread_other" }, THREAD)).toBeNull();
  });
});

describe("canonical render gate (H2+H4 flag-on / partial-canonical)", () => {
  const events = [{ kind: "message.delta", seq: 0 }] as const;
  test("flag OFF never uses canonical, even when complete with events", () => {
    expect(shouldUseCanonicalTimeline(false, { canonical: events, canonicalComplete: true })).toBe(false);
  });
  test("flag ON but NOT complete falls back to legacy (partial-canonical never renders)", () => {
    expect(shouldUseCanonicalTimeline(true, { canonical: events, canonicalComplete: false })).toBe(false);
    expect(shouldUseCanonicalTimeline(true, { canonical: events })).toBe(false); // no completion record
  });
  test("flag ON + complete but EMPTY lane falls back to legacy", () => {
    expect(shouldUseCanonicalTimeline(true, { canonical: [], canonicalComplete: true })).toBe(false);
  });
  test("flag ON + complete + events uses canonical", () => {
    expect(shouldUseCanonicalTimeline(true, { canonical: events, canonicalComplete: true })).toBe(true);
  });
});
