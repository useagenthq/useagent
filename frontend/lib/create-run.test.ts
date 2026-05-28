import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRun, selectRunCreateAttempt } from "./create-run";

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
