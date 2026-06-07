import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { buildThreadPreamble } from "../src/runs/repo";
import { DEV_ORG_ID, DEV_USER_ID } from "../src/seed";
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

  test("POST /api/runs rejects caller-supplied origin", async () => {
    const { status, body } = await json("/api/runs", {
      method: "POST",
      body: { prompt: "not internal", origin: "internal:eval" },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("origin is server-owned");
  });

  test("loopback parity admission persists an internal origin and remains hidden", async () => {
    const previousSecret = process.env.USEAGENT_OPERATOR_SECRET;
    const operatorSecret = "parity-operator-test-secret-with-32-chars";
    process.env.USEAGENT_OPERATOR_SECRET = operatorSecret;
    try {
      const created = await json<{ id: string }>("/api/internal/operator/admit-release-eval", {
        method: "POST",
        headers: {
          authorization: `Bearer ${operatorSecret}`,
          "idempotency-key": `release-eval:${crypto.randomUUID()}`,
        },
        body: {
          orgId: DEV_ORG_ID,
          userId: DEV_USER_ID,
          run: { prompt: "internal release parity", engine: "mock", model: "claude-sonnet-4-5" },
        },
      });
      expect(created.status).toBe(201);
      const [stored] = await db
        .select({ origin: runs.origin })
        .from(runs)
        .where(eq(runs.id, created.body.id))
        .limit(1);
      expect(stored?.origin).toBe("internal:eval");

      const listed = await json<{ runs: Array<{ id: string }> }>("/api/runs?all=1");
      expect(listed.body.runs.some((run) => run.id === created.body.id)).toBe(false);
    } finally {
      if (previousSecret === undefined) delete process.env.USEAGENT_OPERATOR_SECRET;
      else process.env.USEAGENT_OPERATOR_SECRET = previousSecret;
    }
  });

  test("POST /api/runs maps resource failures and persists no run", async () => {
    const marker = crypto.randomUUID();
    const { status, body } = await json<{ error: string; action: string }>(
      "/api/runs",
      {
        method: "POST",
        body: {
          prompt: `test ${marker} https://github.com/upstream-org/backend/pull/19625`,
        },
      },
    );
    expect(status).toBe(403);
    expect(body.error).toBe("resource_unauthorized");
    expect(body.action).toMatch(/connect|select/i);

    const listed = await json<{ runs: Array<{ prompt: string }> }>("/api/runs?all=1");
    expect(listed.body.runs.some((run) => run.prompt.includes(marker))).toBe(false);
  });

  test("fresh and reply runs authorize typed thread resources without cross-org leakage", async () => {
    const mine = await createOrgSession("typed-resources-mine");
    const other = await createOrgSession("typed-resources-other");
    const firstThread = await runToCompletion({ prompt: "first referenced thread" }, mine.cookies);
    const secondThread = await runToCompletion({ prompt: "second referenced thread" }, mine.cookies);
    const selection = (id: string) => ({
      kind: "thread",
      provider: "useagent",
      locator: { type: "thread", id },
    });

    const root = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: mine.cookies,
      body: { prompt: "use the first thread", resources: [selection(firstThread.id)] },
    });
    expect(root.status).toBe(201);
    const rootRun = await json<any>(`/api/runs/${root.body.id}`, { cookies: mine.cookies });
    expect(rootRun.body.resolved_resources).toEqual([
      expect.objectContaining({
        kind: "thread",
        provider: "useagent",
        locator: { type: "thread", id: firstThread.id },
        capabilities: ["thread.read"],
      }),
    ]);

    const reply = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: mine.cookies,
      body: {
        prompt: "also use the second thread",
        parent_run_id: root.body.id,
        resources: [selection(secondThread.id)],
      },
    });
    expect(reply.status).toBe(201);
    const replyRun = await json<any>(`/api/runs/${reply.body.id}`, { cookies: mine.cookies });
    expect(new Set(replyRun.body.resolved_resources.map((resource: any) => resource.locator.id))).toEqual(
      new Set([firstThread.id, secondThread.id]),
    );

    const refused = await json<{ error: string }>("/api/runs", {
      method: "POST",
      cookies: other.cookies,
      body: { prompt: "cross tenant", resources: [selection(firstThread.id)] },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("resource_unauthorized");
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

  test("summary view is org-scoped, newest-first, bounded, and compact", async () => {
    const mine = await createOrgSession("summary-mine");
    const other = await createOrgSession("summary-other");
    await runToCompletion({ prompt: "first summary row" }, mine.cookies);
    const newest = await runToCompletion({ prompt: "second summary row" }, mine.cookies);
    await runToCompletion({ prompt: "other org row" }, other.cookies);

    const list = await json<{ runs: any[] }>("/api/runs?view=summary&limit=1", {
      cookies: mine.cookies,
    });
    expect(list.status).toBe(200);
    expect(list.body.runs).toHaveLength(1);
    expect(list.body.runs[0].id).toBe(newest.id);
    expect(list.body.runs[0]).toHaveProperty("model");
    expect(list.body.runs[0]).toHaveProperty("created_at");
    expect(list.body.runs[0]).toHaveProperty("repos");
    expect(list.body.runs[0]).not.toHaveProperty("steps");
    expect(list.body.runs[0]).not.toHaveProperty("resolved_resources");
    expect(list.body.runs[0]).not.toHaveProperty("engine_session_id");
  });

  test("user-facing run lists hide internal parity traffic without deleting it", async () => {
    const session = await createOrgSession("summary-internal-hidden");
    const publicId = crypto.randomUUID();
    const internalId = crypto.randomUUID();
    await db.insert(runs).values([
      {
        id: publicId,
        orgId: session.orgId,
        userId: null,
        prompt: "product run",
        model: "test-model",
        engine: "mock",
        status: "completed",
        threadId: publicId,
      },
      {
        id: internalId,
        orgId: session.orgId,
        userId: null,
        prompt: "internal parity run",
        model: "test-model",
        engine: "mock",
        status: "completed",
        threadId: internalId,
        origin: "internal:release-parity",
      },
    ]);

    const detailed = await json<{ runs: any[] }>("/api/runs", {
      cookies: session.cookies,
    });
    const summary = await json<{ runs: any[] }>("/api/runs?view=summary&limit=100", {
      cookies: session.cookies,
    });

    expect(detailed.body.runs.some((run) => run.id === publicId)).toBe(true);
    expect(summary.body.runs.some((run) => run.id === publicId)).toBe(true);
    expect(detailed.body.runs.some((run) => run.id === internalId)).toBe(false);
    expect(summary.body.runs.some((run) => run.id === internalId)).toBe(false);

    const stored = await db.select().from(runs).where(eq(runs.id, internalId));
    expect(stored).toHaveLength(1);
  });

  test("summary view can retain active roots older than its completed-run limit", async () => {
    const session = await createOrgSession("summary-active");
    const now = Date.now();
    const completed = Array.from({ length: 101 }, (_, index) => {
      const id = crypto.randomUUID();
      return {
        id,
        orgId: session.orgId,
        userId: null,
        prompt: `completed ${index}`,
        model: "test-model",
        engine: "mock" as const,
        status: "completed" as const,
        threadId: id,
        createdAt: new Date(now - index * 1_000),
        updatedAt: new Date(now - index * 1_000),
      };
    });
    const activeId = crypto.randomUUID();
    const activeReplyId = crypto.randomUUID();
    await db.insert(runs).values([
      ...completed,
      {
        id: activeId,
        orgId: session.orgId,
        userId: null,
        prompt: "older active root",
        model: "test-model",
        engine: "mock",
        status: "running",
        threadId: activeId,
        createdAt: new Date(now - 1_000_000),
        updatedAt: new Date(now - 1_000_000),
      },
      {
        id: activeReplyId,
        orgId: session.orgId,
        userId: null,
        prompt: "older active reply",
        model: "test-model",
        engine: "mock",
        status: "queued",
        parentRunId: completed[0]!.id,
        threadId: completed[0]!.id,
        createdAt: new Date(now - 1_100_000),
        updatedAt: new Date(now - 1_100_000),
      },
    ]);

    const bounded = await json<{ runs: any[] }>("/api/runs?view=summary&limit=100", {
      cookies: session.cookies,
    });
    expect(bounded.body.runs).toHaveLength(100);
    expect(bounded.body.runs.some((run) => run.id === activeId)).toBe(false);

    const sidebar = await json<{ runs: any[] }>(
      "/api/runs?view=summary&limit=100&include_active=1",
      { cookies: session.cookies },
    );
    expect(sidebar.body.runs).toHaveLength(101);
    expect(sidebar.body.runs.some((run) => run.id === activeId)).toBe(true);
    expect(sidebar.body.runs.some((run) => run.id === activeReplyId)).toBe(false);

    const allRuns = await json<{ runs: any[] }>(
      "/api/runs?view=summary&all=1&limit=100&include_active=1",
      { cookies: session.cookies },
    );
    expect(allRuns.body.runs).toHaveLength(102);
    expect(allRuns.body.runs.some((run) => run.id === activeId)).toBe(true);
    expect(allRuns.body.runs.some((run) => run.id === activeReplyId)).toBe(true);
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

  test("thread outline returns per-turn skeletons without step bodies", async () => {
    const mine = await createOrgSession("outline-mine");
    const other = await createOrgSession("outline-other");
    const root = await runToCompletion({ prompt: "outline root" }, mine.cookies);
    const reply = await runToCompletion(
      { prompt: "outline reply", parent_run_id: root.id },
      mine.cookies,
    );

    // From either member of the thread, the outline covers the WHOLE thread
    // oldest→newest (mirrors `?thread=1`).
    const fromReply = await json<{ turns: any[] }>(`/api/runs/${reply.id}/thread-outline`, {
      cookies: mine.cookies,
    });
    expect(fromReply.status).toBe(200);
    expect(fromReply.body.turns.map((t) => t.id)).toEqual([root.id, reply.id]);

    // Skeleton shape only: id/status/step_count/has_summary/created_at - no
    // steps, no prompt, no summary text, no JSON payloads.
    const turn = fromReply.body.turns[0];
    expect(turn.status).toBe("completed");
    expect(turn.step_count).toBe(8); // the scripted worker persists 8 steps
    expect(turn.has_summary).toBe(true);
    expect(typeof turn.created_at).toBe("string");
    expect(turn).not.toHaveProperty("steps");
    expect(turn).not.toHaveProperty("prompt");
    expect(turn).not.toHaveProperty("summary");
    expect(turn).not.toHaveProperty("code_json");

    // Org isolation: another org's session sees a 404, same as `?thread=1`.
    const crossOrg = await json(`/api/runs/${root.id}/thread-outline`, {
      cookies: other.cookies,
    });
    expect(crossOrg.status).toBe(404);
  });

  test("windowed turns fetch returns full turns for requested ids only", async () => {
    const mine = await createOrgSession("turns-mine");
    const other = await createOrgSession("turns-other");
    const root = await runToCompletion({ prompt: "turns root" }, mine.cookies);
    const reply = await runToCompletion(
      { prompt: "turns reply", parent_run_id: root.id },
      mine.cookies,
    );
    const otherThread = await runToCompletion({ prompt: "another thread" }, mine.cookies);
    const foreign = await runToCompletion({ prompt: "foreign org run" }, other.cookies);

    // The requested subset comes back oldest→newest in the SAME ApiRun shape as
    // `?thread=1` (full steps - one wire shape); ids from a different thread or
    // another org are dropped, never leaked.
    const windowed = await json<{ turns: any[] }>(
      `/api/runs/${root.id}/turns?ids=${[reply.id, root.id, otherThread.id, foreign.id].join(",")}`,
      { cookies: mine.cookies },
    );
    expect(windowed.status).toBe(200);
    expect(windowed.body.turns.map((t) => t.id)).toEqual([root.id, reply.id]);
    expect(windowed.body.turns[0].prompt).toBe("turns root");
    expect(windowed.body.turns[0].thread_id).toBe(root.id);
    expect(windowed.body.turns[0].steps.length).toBe(8);
    expect(windowed.body.turns[0].steps[0]).toHaveProperty("run_id", root.id);

    // Bounds: ids are required and capped.
    const missing = await json(`/api/runs/${root.id}/turns`, { cookies: mine.cookies });
    expect(missing.status).toBe(400);
    const tooMany = await json(
      `/api/runs/${root.id}/turns?ids=${Array.from({ length: 31 }, () => crypto.randomUUID()).join(",")}`,
      { cookies: mine.cookies },
    );
    expect(tooMany.status).toBe(400);

    // Org isolation: another org's session sees a 404 for the thread anchor.
    const crossOrg = await json(`/api/runs/${root.id}/turns?ids=${root.id}`, {
      cookies: other.cookies,
    });
    expect(crossOrg.status).toBe(404);
  });

  test("engine context preamble walks the thread without nesting", async () => {
    const root = await runToCompletion({ prompt: "first ask" });
    const queuedId = crypto.randomUUID();
    await db.insert(runs).values({
      id: queuedId,
      orgId: root.org_id,
      userId: root.user_id,
      prompt: "queued sibling must stay out of history",
      model: root.model,
      engine: root.engine,
      status: "queued",
      parentRunId: root.id,
      threadId: root.thread_id,
    });
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
    expect(preamble).not.toContain("queued sibling must stay out of history");
    // No recursive "Follow-up to a previous task…" nesting anywhere.
    expect(preamble).not.toContain("Follow-up to a previous task");

    // A root run gets NO preamble (nothing prior).
    expect(await buildThreadPreamble(root.thread_id, reply.id)).toContain(
      "User: first ask",
    );
    const laterReply = await runToCompletion({
      prompt: "third ask",
      parent_run_id: reply.id,
    });
    const replyPreamble = await buildThreadPreamble(root.thread_id, reply.id);
    expect(replyPreamble).toContain("User: first ask");
    expect(replyPreamble).not.toContain("User: third ask");
    expect(await buildThreadPreamble(root.thread_id, laterReply.id)).toContain(
      "User: second ask",
    );
    const soloRoot = await runToCompletion({ prompt: "solo" });
    expect(await buildThreadPreamble(soloRoot.thread_id, soloRoot.id)).toBe("");
  });
});
