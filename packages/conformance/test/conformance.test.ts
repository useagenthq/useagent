// Slice 7: framework-free conformance harness. It proves the two libraries are
// INDEPENDENTLY consumable by importing ONLY their documented package exports - no Skynet
// backend or frontend source, no React, no provider parser. It plays the role of a sample
// UI: typed API over injected fetch, one reconnecting thread connection, the pure
// canonical reducer, and capability-driven visibility.
//
// HONEST SCOPE: this uses DETERMINISTIC FIXTURES (a fake relay + fake fetch), not a live
// provider. It proves the library contracts + reducer/selectors/idempotency/capabilities.
// A live provider run (real backend + Daytona + a model) is a separate, environment-gated
// proof and is NOT claimed complete here.

import { describe, expect, test } from "bun:test";
import {
  createAgentClient,
  createCanonicalThreadStore,
  selectAssistantText,
  selectToolCalls,
  selectRunIds,
  selectContextMarkers,
  type CanonicalThreadEvent,
  type CanonicalThreadStore,
  type DecodedFrame,
  type EventSourceLike,
  type FetchLike,
  type ResponseLike,
  type TimerHost,
} from "@skynet/agent-client";
import type { HarnessCapabilities } from "@skynet/agent-harness/control";
import { CANONICAL_SCHEMA_VERSION } from "@skynet/agent-harness/canonical";

// ── fake infra (a sample UI injects these; the library owns no globals) ──────────────
const json = (status: number, body: unknown): ResponseLike => ({
  ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
});
const fetchStub: FetchLike = async (url, init) => {
  if (init?.method === "POST" && url.endsWith("/cancel")) return json(202, { id: "run_1", status: "cancelling" });
  if (init?.method === "POST" && url.endsWith("/api/runs")) {
    const body = JSON.parse(init.body ?? "{}") as { parent_run_id?: string };
    return json(200, { id: body.parent_run_id ? "run_2" : "run_1", status: "queued" });
  }
  if (url.includes("?thread=1")) return json(200, { thread: [{ id: "run_1", status: "completed" }] });
  return json(404, {});
};
const timers: TimerHost = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };

class FakeRelay {
  private listeners = new Map<string, (e: { data: string }) => void>();
  createEventSource = (): EventSourceLike => ({
    addEventListener: (type, fn) => { this.listeners.set(type, fn); },
    close: () => {},
    onopen: null,
    onerror: null,
  });
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

let seq = 0;
function ev(over: Partial<CanonicalThreadEvent> & { kind: string } & Record<string, unknown>): CanonicalThreadEvent {
  const deliverySeq = (over.deliverySeq as number) ?? ++seq;
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION, eventId: (over.eventId as string) ?? `e${deliverySeq}`,
    seq: deliverySeq, runId: (over.runId as string) ?? "run_1", threadId: "thr_1", ts: 1,
    identity: { provider: (over.provider as string) ?? "opencode" }, deliverySeq, revision: (over.revision as number) ?? 0,
    ...over,
  } as CanonicalThreadEvent;
}

/** The sample UI's thin sink: route decoded frames into the canonical store. A
 *  canonical-only consumer ignores the native/raw lane entirely. */
function applyToStore(store: CanonicalThreadStore, frame: DecodedFrame): void {
  if (frame.kind === "canonical") store.ingest(frame.event);
  else if (frame.kind === "canonical-complete") store.markComplete(frame.complete.runId);
}

/** Capability-driven visibility - NEVER a provider-name branch. */
function visibleControls(caps: HarnessCapabilities): string[] {
  const out: string[] = [];
  if (caps.cancel) out.push("stop");
  if (caps.approvals) out.push("approve");
  if (caps.questions) out.push("answer");
  if (caps.childSessions) out.push("subagents");
  return out;
}

describe("conformance: libraries are independently consumable (documented exports only)", () => {
  test("create a task, stream canonical assistant + tool state, reduce via selectors", async () => {
    const client = createAgentClient({ fetch: fetchStub, baseUrl: "" });
    const store = createCanonicalThreadStore();
    const relay = new FakeRelay();

    const handle = await client.createRun({ prompt: "hello", engine: "opencode" });
    expect(handle).toEqual({ runId: "run_1", status: "queued" });

    const conn = client.connectThread("run_1", (f) => applyToStore(store, f), {
      createEventSource: relay.createEventSource, timers, poll: () => {},
    });
    conn.start();
    relay.emit("snapshot", { runs: [] }); // health frame
    store.batch(() => {
      relay.emit("canonical", { threadId: "thr_1", event: ev({ eventId: "m1a", kind: "message.delta", messageId: "m1", text: "Hello " }) });
      relay.emit("canonical", { threadId: "thr_1", event: ev({ eventId: "m1b", kind: "message.delta", messageId: "m1", text: "world" }) });
      relay.emit("canonical", { threadId: "thr_1", event: ev({ eventId: "t1", kind: "tool.started", toolCallId: "c1", name: "bash" }) });
      relay.emit("canonical", { threadId: "thr_1", event: ev({ eventId: "t2", kind: "tool.completed", toolCallId: "c1", status: "ok", preview: "done" }) });
      relay.emit("canonical", { threadId: "thr_1", event: ev({ eventId: "k1", kind: "context.marker", markerType: "memory", title: "recalled 3 memories", sourceEventType: "memory.recall" }) });
    });
    conn.stop();

    const snap = store.getSnapshot();
    expect(selectAssistantText(snap)).toBe("Hello world");
    expect(selectToolCalls(snap)).toEqual([{ toolCallId: "c1", name: "bash", title: undefined, status: "ok", preview: "done", error: undefined }]);
    expect(selectContextMarkers(snap)).toEqual([{ markerType: "memory", title: "recalled 3 memories", detail: undefined }]);
  });

  test("complete a real second turn on the same thread; both runs present", async () => {
    const client = createAgentClient({ fetch: fetchStub, baseUrl: "" });
    const store = createCanonicalThreadStore();
    const relay = new FakeRelay();
    const conn = client.connectThread("run_1", (f) => applyToStore(store, f), { createEventSource: relay.createEventSource, timers, poll: () => {} });
    conn.start();
    relay.emit("canonical", { threadId: "thr_1", event: ev({ eventId: "r1", kind: "turn.started", runId: "run_1" }) });

    const reply = await client.reply("run_1", { prompt: "again" });
    expect(reply.runId).toBe("run_2");
    relay.emit("canonical", { threadId: "thr_1", event: ev({ eventId: "r2", kind: "turn.started", runId: "run_2" }) });
    conn.stop();

    expect(selectRunIds(store.getSnapshot())).toEqual(["run_1", "run_2"]);
  });

  test("refresh/reconnect + replay reconstructs WITHOUT duplicates (idempotent revisions)", () => {
    const store = createCanonicalThreadStore();
    const frames = [
      ev({ eventId: "a", kind: "message.delta", messageId: "m", text: "x", deliverySeq: 1 }),
      ev({ eventId: "b", kind: "message.completed", messageId: "m", text: "final", deliverySeq: 2, revision: 1 }),
    ];
    store.batch(() => frames.forEach((f) => store.ingest(f)));
    const before = store.getSnapshot().events.length;
    // simulate a reconnect: the same frames are replayed
    store.batch(() => frames.forEach((f) => store.ingest(f)));
    expect(store.getSnapshot().events.length).toBe(before); // no duplication
    // and a durable snapshot reconcile is also idempotent
    store.reconcile(frames);
    expect(store.getSnapshot().events.length).toBe(before);
  });

  test("stop travels back through the typed client", async () => {
    const client = createAgentClient({ fetch: fetchStub, baseUrl: "" });
    expect(await client.cancel("run_1")).toEqual({ ok: true, status: "cancelling" });
  });

  test("features are gated by CAPABILITIES, not provider name", () => {
    const opencodeCaps: HarnessCapabilities = {
      resume: true, cancel: true, streaming: "parts", authoritativeHistory: true, childSessions: true,
      approvals: true, questions: true, reasoning: true, todos: true, patches: true, usage: true,
    };
    const acpCaps: HarnessCapabilities = {
      resume: true, cancel: false, streaming: "parts", authoritativeHistory: false, childSessions: false,
      approvals: false, questions: false, reasoning: false, todos: false, patches: false, usage: false,
    };
    expect(visibleControls(opencodeCaps)).toEqual(["stop", "approve", "answer", "subagents"]);
    expect(visibleControls(acpCaps)).toEqual([]); // an engine with no native cancel hides Stop - honestly
  });

  test("the reducer is engine-agnostic: swapping the provider changes nothing", () => {
    const build = (provider: string): number => {
      const s = createCanonicalThreadStore();
      s.batch(() => {
        s.ingest(ev({ eventId: "d1", kind: "message.delta", messageId: "m", text: "hi", provider, deliverySeq: 1 }));
        s.ingest(ev({ eventId: "x1", kind: "tool.completed", toolCallId: "c", status: "ok", provider, deliverySeq: 2 }));
      });
      const snap = s.getSnapshot();
      expect(selectAssistantText(snap)).toBe("hi");
      expect(selectToolCalls(snap)).toHaveLength(1);
      return snap.events.length;
    };
    // opencode / claude / codex all reduce identically - no provider branch anywhere.
    expect(build("opencode")).toBe(build("claude"));
    expect(build("claude")).toBe(build("codex"));
  });
});
