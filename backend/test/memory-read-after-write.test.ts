import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { deliverDueCaptures, getCapture } from "../src/memory/capture-outbox";
import { resolveScopedMemory } from "../src/memory/scope";
import { recallScopedMemory } from "../src/memory/team-memory";
import { finalizeRun } from "../src/runs/finalize";
import { createRun, getRun } from "../src/runs/repo";
import "./helpers";

const realFetch = globalThis.fetch;
const previousUrl = process.env.MEMORY_API_URL;
const ORG = "org-memory-read-after-write";

beforeEach(async () => {
  process.env.MEMORY_API_URL = "http://memory.test:8420";
  await db.execute(sql`delete from memory_outbox`);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousUrl === undefined) delete process.env.MEMORY_API_URL;
  else process.env.MEMORY_API_URL = previousUrl;
});

async function createPreferenceRun(prompt = "i like mango") {
  const id = crypto.randomUUID();
  await createRun({
    id,
    prompt,
    model: "test-model",
    engine: "mock",
    orgId: ORG,
    userId: null,
    parentRunId: null,
    threadId: id,
  });
  return id;
}

async function orgPoolsForNewThread() {
  const id = await createPreferenceRun("what fruit do i like?");
  const run = await getRun(id);
  return run ? resolveScopedMemory(run)?.readPools ?? [] : [];
}

function memoryFetch(stored: Array<{ id: string; role: string; content: string }>) {
  let adds = 0;
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ role: string; content: string }>;
    };
    if (path === "/v3/conversation/add") {
      adds += 1;
      for (const message of body.messages ?? []) {
        // One user-authored L0 result is enough to model confirmed upstream
        // recall; assistant summaries are intentionally not local overlay facts.
        if (message.role === "user") {
          stored.push({ id: `message-${stored.length + 1}`, ...message });
        }
      }
      return Response.json({
        code: 0,
        data: { accepted_ids: stored.map((message) => message.id), total_count: stored.length },
      });
    }
    if (path === "/v3/conversation/search") {
      return Response.json({ code: 0, data: { messages: stored } });
    }
    if (path === "/v3/atomic/search") {
      return Response.json({ code: 0, data: { items: [] } });
    }
    if (path === "/v3/scenario/ls") {
      return Response.json({ code: 0, data: { entries: [], total: 0 } });
    }
    if (path === "/v3/core/read") {
      return Response.json({ code: 0, data: {} });
    }
    throw new Error(`unexpected memory endpoint: ${path}`);
  }) as unknown as typeof fetch;
  return { fetchMock, adds: () => adds };
}

test("slow or failed external memory never extends finalize's terminal path", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  const runId = await createPreferenceRun();

  const result = await Promise.race([
    finalizeRun(runId, "completed", "The user shared that they like mango.", 25).then(
      () => "finalized" as const,
    ),
    Bun.sleep(1_000).then(() => "timed-out" as const),
  ]);

  expect(result).toBe("finalized");
  expect(fetches).toBe(0);
  expect((await getCapture(runId))?.state).toBe("pending");
});

test("a committed mango preference overlays immediate new-thread recall before the timer", async () => {
  const { fetchMock } = memoryFetch([]);
  globalThis.fetch = fetchMock;
  const runId = await createPreferenceRun();
  await finalizeRun(runId, "completed", "The user shared that they like mango.", 25);

  const recall = await recallScopedMemory("what fruit do i like?", await orgPoolsForNewThread());

  expect(recall.rendered.toLowerCase()).toContain("i like mango");
  expect(recall.items.some((item) => item.citation.assetId === runId)).toBe(true);
  expect(recall.items[0]?.citation).toMatchObject({
    provider: "useagent-outbox",
    layer: "provisional",
    ref: `useagent:provisional:${runId}`,
  });
  expect((await getCapture(runId))?.state).toBe("pending");
});

test("a long delivering prompt dedupes by full content, not its bounded display", async () => {
  const stored: Array<{ id: string; role: string; content: string }> = [];
  const memory = memoryFetch(stored);
  globalThis.fetch = memory.fetchMock;
  const longPrompt = `i like mango ${"because it is my preferred fruit ".repeat(24)}`;
  const runId = await createPreferenceRun(longPrompt);
  await finalizeRun(runId, "completed", "The user shared a detailed mango preference.", 25);
  await db.execute(sql`update memory_outbox set state = 'delivering' where id = ${runId}`);
  stored.push({ id: "confirmed-long", role: "user", content: longPrompt });

  const recall = await recallScopedMemory("what fruit do i like?", await orgPoolsForNewThread());

  expect(recall.items.filter((item) => item.content.startsWith("i like mango"))).toHaveLength(1);
  expect(recall.items[0]?.content.length).toBe(500);
  expect(recall.items[0]?.citation.provider).toBe("useagent-outbox");
});

test("concurrent drains deliver once, then confirmed upstream recall replaces the overlay", async () => {
  const stored: Array<{ id: string; role: string; content: string }> = [];
  const memory = memoryFetch(stored);
  globalThis.fetch = memory.fetchMock;
  const runId = await createPreferenceRun();
  await finalizeRun(runId, "completed", "The user shared that they like mango.", 25);
  const pools = await orgPoolsForNewThread();

  const pendingRecall = await recallScopedMemory("what fruit do i like?", pools);
  expect(pendingRecall.items.filter((item) => item.content === "i like mango")).toHaveLength(1);

  // A different replica may have claimed the row and crashed or still be
  // delivering it. The committed overlay remains readable in that state.
  await db.execute(sql`update memory_outbox set state = 'delivering' where id = ${runId}`);
  const deliveringRecall = await recallScopedMemory("what fruit do i like?", pools);
  expect(deliveringRecall.items.filter((item) => item.content === "i like mango")).toHaveLength(1);
  await db.execute(sql`update memory_outbox set state = 'pending' where id = ${runId}`);

  await Promise.all([deliverDueCaptures(), deliverDueCaptures()]);
  const confirmedRecall = await recallScopedMemory("what fruit do i like?", pools);

  expect(memory.adds()).toBe(1);
  expect((await getCapture(runId))?.state).toBe("delivered");
  expect(confirmedRecall.items.filter((item) => item.content === "i like mango")).toHaveLength(1);
  expect(confirmedRecall.items.some((item) => item.citation.provider === "useagent-outbox")).toBe(false);
});
