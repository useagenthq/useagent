// Slice 5 gate for the API client: classified HTTP / network / decode errors (never a
// raw throw), faithful request bodies, and connectThread decoding frames to the sink.

import { describe, expect, test } from "bun:test";
import { AgentClientError, createAgentClient, type FetchLike, type ResponseLike } from "../src/api";
import type { EventSourceLike, TimerHost } from "../src/connection";
import type { DecodedFrame } from "../src/thread-events";

function jsonResponse(status: number, body: unknown): ResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("AgentClient HTTP", () => {
  test("createRun POSTs prompt + optional fields and returns a RunHandle", async () => {
    const calls: { url: string; init?: Parameters<FetchLike>[1] }[] = [];
    const fetchStub: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { id: "run_9", status: "queued" });
    };
    const client = createAgentClient({ fetch: fetchStub, baseUrl: "https://x", headers: () => ({ authorization: "Bearer t" }) });
    const handle = await client.createRun({ prompt: "hi", engine: "opencode", repos: ["o/r"], idempotencyKey: "k1" });
    expect(handle).toEqual({ runId: "run_9", status: "queued" });
    expect(calls[0]!.url).toBe("https://x/api/runs");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers?.["Idempotency-Key"]).toBe("k1");
    expect(calls[0]!.init?.headers?.authorization).toBe("Bearer t");
    expect(JSON.parse(calls[0]!.init!.body!)).toMatchObject({ prompt: "hi", engine: "opencode", repos: ["o/r"] });
  });

  test("reply sets parent_run_id in the body", async () => {
    let body = "";
    const client = createAgentClient({ fetch: async (_u, i) => { body = i!.body!; return jsonResponse(200, { id: "r2", status: "queued" }); } });
    await client.reply("root_1", { prompt: "again" });
    expect(JSON.parse(body)).toMatchObject({ prompt: "again", parent_run_id: "root_1" });
  });

  test("HTTP non-2xx -> AgentClientError(http_error) with the status", async () => {
    const client = createAgentClient({ fetch: async () => jsonResponse(500, { error: "boom" }) });
    const err = await client.createRun({ prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentClientError);
    expect(err.code).toBe("http_error");
    expect(err.status).toBe(500);
  });

  test("a thrown fetch -> AgentClientError(network_error)", async () => {
    const client = createAgentClient({ fetch: async () => { throw new Error("ECONNREFUSED"); } });
    await expect(client.getThread("root_1")).rejects.toMatchObject({ code: "network_error" });
  });

  test("an undecodable body -> AgentClientError(decode_error)", async () => {
    const bad: ResponseLike = { ok: true, status: 200, json: async () => { throw new Error("not json"); }, text: async () => "" };
    const client = createAgentClient({ fetch: async () => bad });
    await expect(client.getThread("root_1")).rejects.toMatchObject({ code: "decode_error" });
  });

  test("getThread reads {thread:[...]} and drops malformed rows", async () => {
    const client = createAgentClient({ fetch: async () => jsonResponse(200, { thread: [{ id: "a", status: "done" }, { nope: 1 }] }) });
    const snap = await client.getThread("a");
    expect(snap.runs).toHaveLength(1);
    expect(snap.runs[0]!.id).toBe("a");
  });

  test("cancel returns a classified OperationResult", async () => {
    const client = createAgentClient({ fetch: async () => jsonResponse(202, { id: "r", status: "cancelling" }) });
    expect(await client.cancel("r")).toEqual({ ok: true, status: "cancelling" });
  });
});

describe("AgentClient connectThread", () => {
  test("decodes each SSE frame to a typed DecodedFrame before the sink", () => {
    // Fake EventSource + immediate timers so the connection is fully deterministic.
    const listeners = new Map<string, (e: { data: string }) => void>();
    const fakeEs: EventSourceLike = {
      addEventListener: (t, fn) => listeners.set(t, fn),
      close: () => {},
      onopen: null,
      onerror: null,
    };
    const timers: TimerHost = {
      setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    };
    const client = createAgentClient({ fetch: async () => jsonResponse(200, {}) });
    const got: DecodedFrame[] = [];
    const conn = client.connectThread("root_1", (f) => got.push(f), {
      createEventSource: () => fakeEs,
      timers,
      poll: () => {},
    });
    conn.start();
    // a valid canonical frame + a raw snapshot frame
    listeners.get("canonical")!({
      data: JSON.stringify({
        threadId: "thr_1",
        event: { schemaVersion: 1, eventId: "e1", kind: "turn.started", runId: "run_1", threadId: "thr_1", seq: 1, ts: 1, deliverySeq: 1, revision: 0, identity: { provider: "opencode" } },
      }),
    });
    listeners.get("snapshot")!({ data: JSON.stringify({ runs: [] }) });
    conn.stop();
    expect(got[0]).toMatchObject({ kind: "canonical" });
    expect(got[1]).toMatchObject({ kind: "raw", type: "snapshot" });
  });
});
