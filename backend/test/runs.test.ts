import { describe, expect, test } from "bun:test";
import { buildThreadPreamble } from "../src/runs/repo";
import { createOrgSession, fetchApi, json, readSse, waitFor } from "./helpers";

/** Create a run and resolve once its scripted worker has completed. */
async function runToCompletion(
  body: Record<string, unknown>,
  cookies?: string,
): Promise<any> {
  const created = await json<{ id: string }>("/api/runs", {
    method: "POST",
    body,
    ...(cookies ? { cookies } : {}),
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  return waitFor(async () => {
    const { body: run } = await json<any>(`/api/runs/${id}`, {
      ...(cookies ? { cookies } : {}),
    });
    return run?.status === "completed" ? run : null;
  });
}

describe("runs", () => {
  test("POST /api/runs requires a prompt", async () => {
    const { status, body } = await json("/api/runs", { method: "POST", body: {} });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  test("create → worker completes → steps persisted → list/get shapes", async () => {
    // Create a run.
    const created = await json<{ id: string }>("/api/runs", {
      method: "POST",
      body: { prompt: "add a rate limiter", model: "claude-sonnet-4-5" },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(id).toMatch(/[0-9a-f-]{36}/);

    // The scripted worker (delay collapsed via WORKER_STEP_DELAY_MS) completes fast.
    const done = await waitFor(async () => {
      const { body } = await json<any>(`/api/runs/${id}`);
      return body?.status === "completed" ? body : null;
    });

    // Single-run GET shape (ApiRun, snake_case wire contract).
    expect(done.id).toBe(id);
    expect(done.status).toBe("completed");
    expect(done.prompt).toBe("add a rate limiter");
    expect(done.model).toBe("claude-sonnet-4-5");
    expect(typeof done.summary).toBe("string");
    expect(typeof done.duration_ms).toBe("number");
    expect(done.org_id).toBe("org-skynet-dev"); // dev fallback org
    expect(typeof done.created_at).toBe("string");
    expect(typeof done.updated_at).toBe("string");

    // Steps persisted: the SCRIPT has 8 entries, the last is the terminal "done".
    expect(Array.isArray(done.steps)).toBe(true);
    expect(done.steps.length).toBe(8);
    expect(done.steps.at(-1).kind).toBe("done");
    // idx is 0..7 in order.
    expect(done.steps.map((s: any) => s.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Step wire shape.
    const step = done.steps[0];
    expect(step).toHaveProperty("run_id", id);
    expect(step).toHaveProperty("kind");
    expect(step).toHaveProperty("label");
    expect(step).toHaveProperty("code_json");
    expect(step).toHaveProperty("created_at");

    // List shape: { runs: [...] }, our run present with its steps.
    const list = await json<{ runs: any[] }>("/api/runs");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.runs)).toBe(true);
    const mine = list.body.runs.find((r) => r.id === id);
    expect(mine).toBeDefined();
    expect(mine.steps.length).toBe(8);
  });

  test("GET /api/runs/:id → 404 for unknown id", async () => {
    const { status, body } = await json(`/api/runs/${crypto.randomUUID()}`);
    expect(status).toBe(404);
    expect(body.error).toBeDefined();
  });

  test("SSE stream replays step events then a done event", async () => {
    const created = await json<{ id: string }>("/api/runs", {
      method: "POST",
      body: { prompt: "stream me" },
    });
    const id = created.body.id;

    // Wait for completion so the events endpoint takes the replay-then-done path.
    await waitFor(async () => {
      const { body } = await json<any>(`/api/runs/${id}`);
      return body?.status === "completed" ? body : null;
    });

    const res = await fetchApi(`/api/runs/${id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    // SSE hygiene: anti-buffering headers so proxies deliver frames immediately.
    expect(res.headers.get("cache-control") ?? "").toContain("no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const events = await readSse(res, { timeoutMs: 8000 });
    const steps = events.filter((e) => e.event === "step");
    const done = events.find((e) => e.event === "done");

    expect(steps.length).toBe(8);
    expect(done).toBeDefined();
    const donePayload = JSON.parse(done!.data);
    expect(donePayload).toEqual({ id, status: "completed" });

    // Replayed step frames carry the persisted step shape.
    const firstStep = JSON.parse(steps[0]!.data);
    expect(firstStep).toHaveProperty("run_id", id);
    expect(firstStep).toHaveProperty("idx", 0);
  });
});

describe("run threading", () => {
  test("reply threads under the root: clean prompt, shared thread_id, order", async () => {
    const root = await runToCompletion({ prompt: "build a todo app", model: "thread-fixed-model" });
    const rootId = root.id;
    // A root run threads under its own id and has no parent.
    expect(root.thread_id).toBe(rootId);
    expect(root.parent_run_id).toBeNull();

    const reply = await runToCompletion({
      prompt: "and now add auth",
      parent_run_id: rootId,
    });

    // Stored prompt is the user's RAW text only — no nested context.
    expect(reply.prompt).toBe("and now add auth");
    expect(reply.parent_run_id).toBe(rootId);
    // Same conversation → same thread_id (the root's id).
    expect(reply.thread_id).toBe(rootId);
    // A reply with no supported model override inherits the thread model server-side.
    expect(reply.model).toBe("thread-fixed-model");

    // GET ?thread=1 returns the whole thread oldest→newest, from either id.
    const fromRoot = await json<{ thread: any[] }>(`/api/runs/${rootId}?thread=1`);
    expect(fromRoot.status).toBe(200);
    expect(fromRoot.body.thread.map((r) => r.id)).toEqual([rootId, reply.id]);
    expect(fromRoot.body.thread[0].steps.length).toBe(8); // steps come along

    const fromReply = await json<{ thread: any[] }>(
      `/api/runs/${reply.id}?thread=1`,
    );
    expect(fromReply.body.thread.map((r) => r.id)).toEqual([rootId, reply.id]);
  });

  test("runs list shows only roots by default; ?all=1 includes replies", async () => {
    // Isolated org so list membership is unambiguous.
    const s = await createOrgSession("thread");
    const root = await runToCompletion({ prompt: "root task" }, s.cookies);
    const reply = await runToCompletion(
      { prompt: "reply task", parent_run_id: root.id },
      s.cookies,
    );

    const def = await json<{ runs: any[] }>("/api/runs", { cookies: s.cookies });
    const defIds = def.body.runs.map((r) => r.id);
    expect(defIds).toContain(root.id);
    expect(defIds).not.toContain(reply.id); // reply hidden by default
    // Every run carries thread_id on the list.
    expect(def.body.runs.find((r) => r.id === root.id).thread_id).toBe(root.id);

    const all = await json<{ runs: any[] }>("/api/runs?all=1", {
      cookies: s.cookies,
    });
    const allIds = all.body.runs.map((r) => r.id);
    expect(allIds).toContain(root.id);
    expect(allIds).toContain(reply.id); // reply visible with ?all=1
  });

  test("reply to an unknown parent_run_id → 404", async () => {
    const res = await json(`/api/runs`, {
      method: "POST",
      body: { prompt: "orphan", parent_run_id: crypto.randomUUID() },
    });
    expect(res.status).toBe(404);
  });

  test("engine context preamble walks the thread without nesting", async () => {
    const root = await runToCompletion({ prompt: "first ask" });
    const reply = await runToCompletion({
      prompt: "second ask",
      parent_run_id: root.id,
    });

    // The preamble a NEXT turn's engine would receive (exclude a fresh id).
    const preamble = await buildThreadPreamble(root.thread_id, crypto.randomUUID());
    // Framing states this IS the engine's own history of the ongoing conversation
    // (the weak "context:" wording made engines claim they "start fresh").
    expect(preamble.startsWith("This is an ONGOING conversation")).toBe(true);
    // Both prior turns rendered as clean User/You-replied pairs, oldest first.
    expect(preamble.indexOf("User: first ask")).toBeLessThan(
      preamble.indexOf("User: second ask"),
    );
    expect(preamble).toContain(`You replied: ${root.summary}`);
    expect(preamble).toContain(`You replied: ${reply.summary}`);
    // No recursive "Follow-up to a previous task…" nesting anywhere.
    expect(preamble).not.toContain("Follow-up to a previous task");

    // A root run gets NO preamble (nothing prior).
    expect(await buildThreadPreamble(root.thread_id, reply.id)).toContain(
      "User: first ask",
    );
    const soloRoot = await runToCompletion({ prompt: "solo" });
    expect(await buildThreadPreamble(soloRoot.thread_id, soloRoot.id)).toBe("");
  });
});
