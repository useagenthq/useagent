/**
 * Lightweight Chat route boundary (#122). Runs in-process against the mounted
 * app (dev-org auth). The test preload strips OPENROUTER_API_KEY, so the route is
 * inert (503) by default; the validation cases set a dummy key so they reach the
 * 400 guards WITHOUT ever hitting the network (every assertion returns before the
 * SSE stream / any LLM call). The retrieval assembly is covered by
 * src/chat/retrieve.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { json } from "./helpers";

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
});

describe("POST /api/chat", () => {
  test("503 when the chat LLM is unconfigured (no OPENROUTER_API_KEY)", async () => {
    const { status, body } = await json("/api/chat", {
      method: "POST",
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(status).toBe(503);
    expect(body).toMatchObject({ error: expect.stringContaining("OPENROUTER_API_KEY") });
  });

  test("400 on invalid JSON body (configured)", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const { status } = await json("/api/chat", {
      method: "POST",
      body: "{ not json",
      headers: { "content-type": "application/json" },
    });
    expect(status).toBe(400);
  });

  test("400 when messages is empty / has no user turn (configured)", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const empty = await json("/api/chat", { method: "POST", body: { messages: [] } });
    expect(empty.status).toBe(400);

    const noUser = await json("/api/chat", {
      method: "POST",
      body: { messages: [{ role: "assistant", content: "hi" }] },
    });
    expect(noUser.status).toBe(400);

    const malformed = await json("/api/chat", {
      method: "POST",
      body: { messages: [{ role: "user" }] },
    });
    expect(malformed.status).toBe(400);
  });
});
