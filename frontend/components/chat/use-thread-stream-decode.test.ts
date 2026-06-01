// Slice 6: the SSE decode->apply path now runs through the client library's decodeFrame
// + this thin product adapter (applyDecodedFrame). This locks the mapping onto the store
// (previously an internal, untested hook function) so the rewire is behavior-verified.

import { describe, expect, test } from "bun:test";
import { applyDecodedFrame } from "./use-thread-stream";
import { decodeFrame } from "@useagent/agent-client";
import { createThreadStore } from "./thread-store";

const canonicalEvent = (over: Record<string, unknown>) => ({
  schemaVersion: 1, eventId: "e1", kind: "message.delta", messageId: "m", text: "hi",
  runId: "r1", threadId: "t1", seq: 1, ts: 1, deliverySeq: 1, revision: 0,
  identity: { provider: "opencode" }, ...over,
});
const apply = (store: ReturnType<typeof createThreadStore>, event: string, obj: unknown) =>
  applyDecodedFrame(store, decodeFrame(event, JSON.stringify(obj)));
const seedRun = (s: ReturnType<typeof createThreadStore>) =>
  apply(s, "run", { run: { id: "r1", status: "running", steps: [], created_at: "", summary: null } });

describe("applyDecodedFrame maps decoded frames onto the product store", () => {
  test("snapshot -> applySnapshot (native run lane)", () => {
    const s = createThreadStore();
    apply(s, "snapshot", { runs: [{ id: "r1", status: "running", steps: [], created_at: "", summary: null }] });
    expect(s.getSnapshot().byId.has("r1")).toBe(true);
  });

  test("run -> upsertRun", () => {
    const s = createThreadStore();
    seedRun(s);
    expect(s.getSnapshot().byId.get("r1")?.run.status).toBe("running");
  });

  test("done -> applyDone updates status", () => {
    const s = createThreadStore();
    seedRun(s);
    apply(s, "done", { runId: "r1", status: "completed" });
    expect(s.getSnapshot().byId.get("r1")?.status).toBe("completed");
  });

  test("canonical -> applyCanonical (canonical lane, deduped by eventId/revision)", () => {
    const s = createThreadStore();
    seedRun(s);
    apply(s, "canonical", { threadId: "t1", event: canonicalEvent({ eventId: "c1", deliverySeq: 1, revision: 0 }) });
    apply(s, "canonical", { threadId: "t1", event: canonicalEvent({ eventId: "c1", kind: "message.completed", text: "final", deliverySeq: 3, revision: 1 }) });
    const run = s.getSnapshot().byId.get("r1");
    expect(run?.canonical).toHaveLength(1);
    expect(run?.canonical[0]?.kind).toBe("message.completed");
  });

  test("canonical-complete -> markCanonicalComplete", () => {
    const s = createThreadStore();
    seedRun(s);
    apply(s, "canonical", { threadId: "t1", event: canonicalEvent({ eventId: "c1" }) });
    expect(s.getSnapshot().byId.get("r1")?.canonicalComplete).toBe(false);
    apply(s, "canonical-complete", { threadId: "t1", complete: { runId: "r1" } });
    expect(s.getSnapshot().byId.get("r1")?.canonicalComplete).toBe(true);
  });

  test("a canonical frame with a mismatched thread is dropped (validator parity)", () => {
    const s = createThreadStore();
    seedRun(s);
    apply(s, "canonical", { threadId: "OTHER", event: canonicalEvent({ eventId: "c1" }) });
    expect(s.getSnapshot().byId.get("r1")?.canonical).toHaveLength(0); // dropped, never applied cross-thread
  });

  test("delta (no kind) -> applyDelta answer narration", () => {
    const s = createThreadStore();
    seedRun(s);
    apply(s, "delta", { runId: "r1", delta: "hello" });
    expect(s.getSnapshot().byId.get("r1")?.liveText).toBe("hello");
    expect(s.getSnapshot().byId.get("r1")?.liveReasoning).toBe("");
  });

  test("delta with kind:reasoning -> live thinking buffer, never the answer", () => {
    const s = createThreadStore();
    seedRun(s);
    apply(s, "delta", { runId: "r1", delta: "thinking...", kind: "reasoning" });
    const run = s.getSnapshot().byId.get("r1");
    expect(run?.liveReasoning).toBe("thinking...");
    expect(run?.liveText).toBe("");
  });

  test("malformed JSON and unknown event kinds are ignored, never fatal", () => {
    const s = createThreadStore();
    applyDecodedFrame(s, decodeFrame("canonical", "{not json"));
    applyDecodedFrame(s, decodeFrame("some-future-frame", JSON.stringify({ x: 1 })));
    expect(s.getSnapshot().runs).toHaveLength(0);
  });
});
