import { afterEach, describe, expect, test } from "bun:test";
import { getRun } from "../src/runs/repo";
import { fetchApi, json, readSse, waitFor } from "./helpers";

const realFetch = globalThis.fetch;

function openRouterStream(...deltas: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const delta of deltas) {
          await Bun.sleep(15);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
            ),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.CHAT_MODEL;
});

describe("durable chat runs", () => {
  test("explicit chat engine requires the chat LLM configuration", async () => {
    const res = await json("/api/runs", {
      method: "POST",
      body: { prompt: "hello", engine: "chat", model: "anthropic/claude-sonnet-5" },
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "engine_not_ready",
      engine: "chat",
    });
  });

  test("streams direct chat through the durable run/thread/event model without a sandbox", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        stream: boolean;
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.model).toBe("anthropic/claude-sonnet-5");
      expect(body.stream).toBe(true);
      expect(body.messages.at(-1)).toEqual({ role: "user", content: "hello durable chat" });
      expect(body.messages[0]?.content).toContain("NO sandbox");
      expect(body.messages[0]?.content).toContain("<resource_access_snapshot>");
      expect(body.messages[0]?.content).toContain('"exactInventoryTool":null');
      return openRouterStream("Hello ", "durable chat");
    }) as typeof fetch;

    const created = await json<{ id: string }>("/api/runs", {
      method: "POST",
      body: { prompt: "hello durable chat", engine: "chat", model: "anthropic/claude-sonnet-5" },
    });
    expect(created.status).toBe(201);

    const eventsResponse = await fetchApi(`/api/runs/${created.body.id}/events`);
    expect(eventsResponse.status).toBe(200);
    const events = await readSse(eventsResponse, { timeoutMs: 8_000 });

    const deltas = events
      .filter((event) => event.event === "delta")
      .map((event) => JSON.parse(event.data).delta);
    expect(deltas).toEqual(["Hello ", "durable chat"]);

    const done = await waitFor(async () => {
      const res = await json<any>(`/api/runs/${created.body.id}`);
      return res.body?.status === "completed" ? res.body : null;
    });
    expect(done.engine).toBe("chat");
    expect(done.thread_id).toBe(created.body.id);
    expect(done.parent_run_id).toBeNull();
    expect(done.engine_session_id).toBeNull();
    expect(done.summary).toBe("Hello durable chat");
    expect(done.steps.map((step: any) => step.label)).toEqual([
      "Preparing chat context...",
      "Done",
    ]);

    const row = await getRun(created.body.id);
    expect(row?.sandboxId).toBeNull();
    expect(calls.filter((url) => url.includes("/chat/completions"))).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
  });

  test("chat replies inherit their durable thread", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const latest = body.messages.at(-1)?.content ?? "";
      return openRouterStream(latest === "second" ? "reply answer" : "root answer");
    }) as typeof fetch;

    const root = await json<{ id: string }>("/api/runs", {
      method: "POST",
      body: { prompt: "first", engine: "chat", model: "anthropic/claude-sonnet-5" },
    });
    expect(root.status).toBe(201);
    await waitFor(async () => {
      const res = await json<any>(`/api/runs/${root.body.id}`);
      return res.body?.status === "completed" ? res.body : null;
    });

    const reply = await json<{ id: string }>("/api/runs", {
      method: "POST",
      body: { prompt: "second", parent_run_id: root.body.id },
    });
    expect(reply.status).toBe(201);
    const done = await waitFor(async () => {
      const res = await json<any>(`/api/runs/${reply.body.id}`);
      return res.body?.status === "completed" ? res.body : null;
    });

    expect(done.engine).toBe("chat");
    expect(done.parent_run_id).toBe(root.body.id);
    expect(done.thread_id).toBe(root.body.id);

    const thread = await json<{ thread: any[] }>(`/api/runs/${reply.body.id}?thread=1`);
    expect(thread.body.thread.map((run) => run.id)).toEqual([root.body.id, reply.body.id]);
    expect(thread.body.thread.map((run) => run.summary)).toEqual([
      "root answer",
      "reply answer",
    ]);
  });

  test("applies a pinned skill to durable chat without leaking it into the user prompt", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    let systemPrompt = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      systemPrompt = body.messages[0]?.content ?? "";
      return openRouterStream("skill applied");
    }) as typeof fetch;

    const skill = await json<{ id: string; current_version: number }>("/api/skills", {
      method: "POST",
      body: {
        name: `Durable chat skill ${Date.now()}`,
        description: "Use the requested response style.",
        tags: ["chat"],
        sections: {
          overview: ["This skill governs direct chat."],
          procedure: ["End every answer with the exact word PINEAPPLE."],
          verify: ["The final word is PINEAPPLE."],
        },
      },
    });
    expect(skill.status).toBe(201);

    const created = await json<{ id: string }>("/api/runs", {
      method: "POST",
      body: {
        prompt: "answer briefly",
        engine: "chat",
        model: "anthropic/claude-sonnet-5",
        skill: { id: skill.body.id, version: skill.body.current_version },
      },
    });
    expect(created.status).toBe(201);

    const done = await waitFor(async () => {
      const res = await json<any>(`/api/runs/${created.body.id}`);
      return res.body?.status === "completed" ? res.body : null;
    });
    expect(done.prompt).toBe("answer briefly");
    expect(systemPrompt).toContain("End every answer with the exact word PINEAPPLE.");
    expect(systemPrompt).not.toContain("Promote to Agent");
  });
});
