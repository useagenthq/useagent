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
  selectCommands,
  selectLatestUsage,
  type CanonicalThreadEvent,
  type CanonicalThreadStore,
  type DecodedFrame,
  type EventSourceLike,
  type FetchLike,
  type ResponseLike,
  type TimerHost,
} from "@useagent/agent-client";
import type { HarnessCapabilities } from "@useagent/agent-harness/control";
import { CANONICAL_SCHEMA_VERSION } from "@useagent/agent-harness/canonical";

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

function recordingFetch(): { fetch: FetchLike; requests: { url: string; init?: Parameters<FetchLike>[1] }[] } {
  const requests: { url: string; init?: Parameters<FetchLike>[1] }[] = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (init?.method === "POST" && url.endsWith("/api/runs")) {
        const body = JSON.parse(init.body ?? "{}") as { parent_run_id?: string };
        return json(200, { id: body.parent_run_id ? "run_reply" : "run_root", status: "queued" });
      }
      if (init?.method === "POST" && url.endsWith("/cancel")) {
        return json(202, { id: "run_root", status: "cancelling" });
      }
      return json(404, {});
    },
  };
}

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

  test("start, resume, steer, model selection, and cancel keep one typed product API", async () => {
    const { fetch, requests } = recordingFetch();
    const client = createAgentClient({
      fetch,
      baseUrl: "https://skynet.example.test/",
      headers: () => ({ authorization: "Bearer session" }),
    });

    await expect(client.createRun({
      prompt: "start",
      engine: "opencode",
      model: "openai/gpt-5.6-luna",
      repos: ["acme/new-skynet"],
      memoryScope: "personal",
      idempotencyKey: "idem-root",
    })).resolves.toEqual({ runId: "run_root", status: "queued" });
    await expect(client.reply("run_root", {
      prompt: "/review auth",
      engine: "codex",
      model: "gpt-5.6-sol",
      idempotencyKey: "idem-reply",
    })).resolves.toEqual({ runId: "run_reply", status: "queued" });
    await expect(client.cancel("run_root")).resolves.toEqual({ ok: true, status: "cancelling" });

    expect(requests.map((r) => r.url)).toEqual([
      "https://skynet.example.test/api/runs",
      "https://skynet.example.test/api/runs",
      "https://skynet.example.test/api/runs/run_root/cancel",
    ]);
    expect(requests[0]!.init?.headers).toMatchObject({
      authorization: "Bearer session",
      "content-type": "application/json",
      "Idempotency-Key": "idem-root",
    });
    expect(JSON.parse(requests[0]!.init?.body ?? "{}")).toEqual({
      prompt: "start",
      engine: "opencode",
      model: "openai/gpt-5.6-luna",
      repos: ["acme/new-skynet"],
      memory_scope: "personal",
    });
    expect(requests[1]!.init?.headers).toMatchObject({ "Idempotency-Key": "idem-reply" });
    expect(JSON.parse(requests[1]!.init?.body ?? "{}")).toEqual({
      prompt: "/review auth",
      engine: "codex",
      model: "gpt-5.6-sol",
      parent_run_id: "run_root",
    });
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

  test("cross-thread replay frames are rejected before they can affect the store", () => {
    const client = createAgentClient({ fetch: fetchStub, baseUrl: "" });
    const store = createCanonicalThreadStore();
    const relay = new FakeRelay();
    const conn = client.connectThread("run_1", (f) => applyToStore(store, f), {
      createEventSource: relay.createEventSource, timers, poll: () => {},
    });
    conn.start();

    relay.emit("canonical", {
      threadId: "thr_1",
      event: ev({
        eventId: "wrong-thread",
        kind: "message.delta",
        messageId: "m",
        text: "wrong",
        threadId: "thr_2",
      }),
    });
    relay.emit("canonical", {
      threadId: "thr_1",
      event: ev({ eventId: "right-thread", kind: "message.delta", messageId: "m", text: "right", threadId: "thr_1" }),
    });
    conn.stop();

    expect(selectAssistantText(store.getSnapshot())).toBe("right");
    expect(store.getSnapshot().events.map((event) => event.eventId)).toEqual(["right-thread"]);
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

  test("artifact, subagent, command, model, and usage events are durable canonical data", () => {
    const store = createCanonicalThreadStore();
    const artifact = {
      artifactId: "artifact_1",
      bytes: 1234,
      sha256: "a".repeat(64),
      contentType: "image/png",
    };
    store.batch(() => {
      store.ingest(ev({ eventId: "session", kind: "session.started", capabilities: {
        streamingText: true, reasoning: true, plans: true, toolProgress: true, fileDiffs: true,
        nativeChildProjection: true, gatewayChildSessions: true, approvals: false, questions: true,
        usage: true, modelSelection: true,
        commands: true, directTerminal: true, resume: true, load: true, close: false, stop: true,
        reconcile: true, desktop: false, nativeEmbed: true, knowledgeTools: true,
      } }));
      store.ingest(ev({
        eventId: "commands",
        kind: "commands.updated",
        commands: ["review"],
        catalog: [{ name: "review", description: "Review current changes" }],
        source: "opencode",
        generation: 4,
      }));
      store.ingest(ev({ eventId: "mode", kind: "mode.updated", mode: "agent", model: "openai/gpt-5.6-luna" }));
      store.ingest(ev({ eventId: "child-start", kind: "child.started", childId: "child_1", launchToolCallId: "tool_1", title: "Review tests" }));
      store.ingest(ev({ eventId: "tool-start", kind: "tool.started", toolCallId: "tool_1", name: "subagent", title: "Review tests" }));
      store.ingest(ev({ eventId: "tool-done", kind: "tool.completed", toolCallId: "tool_1", status: "ok", preview: "passed", artifact }));
      store.ingest(ev({ eventId: "artifact-created", kind: "artifact.created", name: "screenshot.png", artifact }));
      store.ingest(ev({ eventId: "artifact-delivered", kind: "artifact.delivered", name: "screenshot.png", destination: "browser", artifact }));
      store.ingest(ev({ eventId: "usage", kind: "usage.updated", inputTokens: 10, outputTokens: 20, costUsd: 0.03 }));
    });

    expect(selectCommands(store.getSnapshot())).toEqual([{ name: "review", description: "Review current changes" }]);
    expect(selectToolCalls(store.getSnapshot())).toEqual([{
      toolCallId: "tool_1",
      name: "subagent",
      title: "Review tests",
      status: "ok",
      preview: "passed",
      error: undefined,
    }]);
    expect(selectLatestUsage(store.getSnapshot())).toEqual({ inputTokens: 10, outputTokens: 20, costUsd: 0.03 });
    expect(store.getSnapshot().events.filter((event) => event.kind.startsWith("artifact."))).toHaveLength(2);
    expect(store.getSnapshot().events.find((event) => event.kind === "child.started")).toMatchObject({
      childId: "child_1",
      launchToolCallId: "tool_1",
    });
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
