import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createRun,
  createThreadMessage,
  continueNativeChildAsSession,
  runCreateFailureMessage,
  selectRunCreateAttempt,
} from "./create-run";

interface FetchCall {
  input: RequestInfo | URL;
  init?: RequestInit;
}

const originalFetch = globalThis.fetch;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
let calls: FetchCall[] = [];
let responses: Response[] = [];

beforeEach(() => {
  calls = [];
  responses = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (!response) throw new Error("missing mocked response");
    return response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("createRun", () => {
  test("retries one transient failure with the same idempotency key and body", async () => {
    responses.push(new Response(null, { status: 502 }), Response.json({ id: "run-1" }));
    const body = { prompt: "Ship it", engine: "opencode" };

    const response = await createRun(body, "run-key-1");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.input).toBe("/api/runs");
      expect(call.init?.body).toBe(JSON.stringify(body));
      expect(new Headers(call.init?.headers).get("Idempotency-Key")).toBe("run-key-1");
    }
  });

  test("returns a persistent transient failure after one bounded retry", async () => {
    responses.push(new Response(null, { status: 503 }), new Response(null, { status: 503 }));

    const response = await createRun({ prompt: "Still failing" }, "run-key-2");

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(2);
  });
});

describe("createThreadMessage", () => {
  test("targets the exact ordinary child thread with the caller's stable key", async () => {
    responses.push(Response.json({ id: "followup-1" }, { status: 201 }));
    await createThreadMessage(
      "child/one",
      { text: "Add keyboard navigation", attachments: ["upload-1"] },
      "message-key-1",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/api/threads/child%2Fone/messages");
    expect(new Headers(calls[0]?.init?.headers).get("Idempotency-Key")).toBe("message-key-1");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      text: "Add keyboard navigation",
      attachments: ["upload-1"],
    });
  });
});

describe("continueNativeChildAsSession", () => {
  test("posts the exact execution identity to the thread continuation route", async () => {
    responses.push(Response.json({ id: "run-child", thread_id: "thread-child" }, { status: 201 }));
    await continueNativeChildAsSession(
      "parent/thread",
      "00000000-0000-4000-8000-000000000001",
      "Continue research",
      "continue-key",
    );
    expect(calls[0]?.input).toBe("/api/threads/parent%2Fthread/continue-native-child");
    expect(new Headers(calls[0]?.init?.headers).get("idempotency-key")).toBe("continue-key");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      executionId: "00000000-0000-4000-8000-000000000001",
      title: "Continue research",
      idempotencyKey: "continue-key",
    });
  });
});

describe("selectRunCreateAttempt", () => {
  test("keeps the key for a manual retry of the same effective payload", () => {
    const first = selectRunCreateAttempt({ prompt: "Retry me", engine: "opencode" }, null, () =>
      "run-key-1"
    );

    const retry = selectRunCreateAttempt(
      { prompt: "Retry me", engine: "opencode" },
      first,
      () => "unexpected-new-key",
    );

    expect(retry).toBe(first);
    expect(retry.idempotencyKey).toBe("run-key-1");
  });

  test("creates a new key when the effective payload changes", () => {
    const keys = ["run-key-1", "run-key-2"];
    const generateKey = () => keys.shift() ?? "unexpected-key";
    const first = selectRunCreateAttempt({ prompt: "First" }, null, generateKey);

    const changed = selectRunCreateAttempt({ prompt: "Changed" }, first, generateKey);

    expect(changed.idempotencyKey).toBe("run-key-2");
    expect(changed).not.toBe(first);
  });
});

describe("runCreateFailureMessage", () => {
  test("surfaces an actionable backend provider error", async () => {
    expect(await runCreateFailureMessage(Response.json({
      error: "model_provider_not_ready",
      message: "Anthropic reports insufficient credits. Add credits in Settings.",
    }, { status: 403 }))).toBe(
      "Anthropic reports insufficient credits. Add credits in Settings.",
    );
  });

  test("uses the fallback for an unstructured response", async () => {
    expect(await runCreateFailureMessage(new Response(null, { status: 503 }), "backend 503"))
      .toBe("backend 503");
  });
});
