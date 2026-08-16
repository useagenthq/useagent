// Slice 5 gate for the pure canonical store: replay batching, idempotent revisions,
// deliverySeq ordering, reconcile, stable snapshots. No React, no product store.

import { describe, expect, test } from "bun:test";
import { createCanonicalThreadStore } from "../src/thread-store";
import type { CanonicalThreadEvent } from "../src/thread-events";
import { selectAssistantText, selectToolCalls } from "../src/selectors";

let seq = 0;
function ev(over: Partial<CanonicalThreadEvent> & { kind: string } & Record<string, unknown>): CanonicalThreadEvent {
  const deliverySeq = (over.deliverySeq as number) ?? ++seq;
  return {
    schemaVersion: 1,
    eventId: (over.eventId as string) ?? `evt_${deliverySeq}`,
    seq: deliverySeq,
    runId: (over.runId as string) ?? "run_1",
    threadId: (over.threadId as string) ?? "thr_1",
    ts: 1,
    identity: { provider: "opencode" },
    deliverySeq,
    revision: (over.revision as number) ?? 0,
    ...over,
  } as CanonicalThreadEvent;
}

describe("canonical thread store", () => {
  test("ingest dedupes by eventId; latest revision wins; stale/dup is a no-op", () => {
    const s = createCanonicalThreadStore();
    expect(s.ingest(ev({ eventId: "e1", kind: "message.delta", messageId: "m", text: "a", revision: 0, deliverySeq: 1 }))).toBe(true);
    // duplicate (same revision) -> no change
    expect(s.ingest(ev({ eventId: "e1", kind: "message.delta", messageId: "m", text: "a", revision: 0, deliverySeq: 1 }))).toBe(false);
    // newer revision -> replaces
    expect(s.ingest(ev({ eventId: "e1", kind: "message.completed", messageId: "m", text: "final", revision: 1, deliverySeq: 5 }))).toBe(true);
    // stale revision arriving late -> ignored
    expect(s.ingest(ev({ eventId: "e1", kind: "message.delta", messageId: "m", text: "a", revision: 0, deliverySeq: 1 }))).toBe(false);
    const snap = s.getSnapshot();
    expect(snap.events).toHaveLength(1);
    expect(snap.events[0]!.kind).toBe("message.completed");
  });

  test("orders by deliverySeq regardless of ingest order", () => {
    const s = createCanonicalThreadStore();
    s.ingest(ev({ eventId: "b", kind: "turn.started", deliverySeq: 3 }));
    s.ingest(ev({ eventId: "a", kind: "turn.started", deliverySeq: 1 }));
    s.ingest(ev({ eventId: "c", kind: "turn.completed", deliverySeq: 2 }));
    expect(s.getSnapshot().events.map((e) => e.deliverySeq)).toEqual([1, 2, 3]);
  });

  test("batch coalesces a replay burst into ONE listener notification", () => {
    const s = createCanonicalThreadStore();
    let notifications = 0;
    s.subscribe(() => { notifications++; });
    s.batch(() => {
      for (let i = 1; i <= 50; i++) s.ingest(ev({ eventId: `e${i}`, kind: "message.delta", messageId: "m", text: "x", deliverySeq: i }));
    });
    expect(notifications).toBe(1);
    expect(s.getSnapshot().events).toHaveLength(50);
  });

  test("getSnapshot returns a STABLE reference until the next mutation", () => {
    const s = createCanonicalThreadStore();
    s.ingest(ev({ eventId: "e1", kind: "turn.started", deliverySeq: 1 }));
    const a = s.getSnapshot();
    expect(s.getSnapshot()).toBe(a); // no mutation -> same ref
    s.ingest(ev({ eventId: "e2", kind: "turn.completed", deliverySeq: 2 }));
    expect(s.getSnapshot()).not.toBe(a); // mutation -> new ref
  });

  test("reconcile replaces the whole index (dedup latest revision) + complete set", () => {
    const s = createCanonicalThreadStore();
    s.ingest(ev({ eventId: "old", kind: "turn.started", deliverySeq: 9 }));
    s.reconcile(
      [
        ev({ eventId: "e1", kind: "message.delta", messageId: "m", text: "a", revision: 0, deliverySeq: 1 }),
        ev({ eventId: "e1", kind: "message.completed", messageId: "m", text: "final", revision: 1, deliverySeq: 2 }),
      ],
      ["run_1"],
    );
    const snap = s.getSnapshot();
    expect(snap.events).toHaveLength(1);
    expect(snap.events[0]!.kind).toBe("message.completed");
    expect(snap.completeRuns.has("run_1")).toBe(true);
  });

  test("markComplete is idempotent", () => {
    const s = createCanonicalThreadStore();
    expect(s.markComplete("run_1")).toBe(true);
    expect(s.markComplete("run_1")).toBe(false);
    expect(s.getSnapshot().completeRuns.has("run_1")).toBe(true);
  });

  test("selectors derive assistant text + tool calls from the transcript", () => {
    const s = createCanonicalThreadStore();
    s.batch(() => {
      s.ingest(ev({ eventId: "d1", kind: "message.delta", messageId: "m1", text: "Hello ", deliverySeq: 1 }));
      s.ingest(ev({ eventId: "d2", kind: "message.delta", messageId: "m1", text: "world", deliverySeq: 2 }));
      s.ingest(ev({ eventId: "t1", kind: "tool.started", toolCallId: "c1", name: "bash", deliverySeq: 3 }));
      s.ingest(ev({ eventId: "t2", kind: "tool.completed", toolCallId: "c1", status: "ok", preview: "done", deliverySeq: 4 }));
    });
    const snap = s.getSnapshot();
    expect(selectAssistantText(snap)).toBe("Hello world");
    const tools = selectToolCalls(snap);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ toolCallId: "c1", name: "bash", status: "ok", preview: "done" });
  });

  test("tool selector retains semantic identity and terminal error detail", () => {
    const s = createCanonicalThreadStore();
    s.ingest(ev({
      eventId: "tool-start",
      kind: "tool.started",
      toolCallId: "call-1",
      name: "github_clone_repository",
      title: "Clone repository",
      deliverySeq: 1,
    }));
    s.ingest(ev({
      eventId: "tool-done",
      kind: "tool.completed",
      toolCallId: "call-1",
      status: "error",
      preview: "authentication failed",
      error: "credential rejected",
      deliverySeq: 2,
    }));

    expect(selectToolCalls(s.getSnapshot())).toEqual([{
      toolCallId: "call-1",
      name: "github_clone_repository",
      title: "Clone repository",
      status: "error",
      preview: "authentication failed",
      error: "credential rejected",
    }]);
  });
});
