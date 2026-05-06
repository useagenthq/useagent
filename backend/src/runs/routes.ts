import { Hono } from "hono";
import type { AppEnv } from "../http";
import { ENGINE_IDS, type EngineId } from "../db/schema";
import { orgScope } from "../middleware/org";
import {
  getRun,
  getRunForOrg,
  getRunWithSteps,
  getStepsApi,
  getThreadForRun,
  listRunsWithSteps,
} from "./repo";
import { acceptRunCommand, markCommandDispatched } from "../commands/repo";
import { bus, channel, spawnWorker, type BusEvent } from "../worker";
import { turnStream } from "./turn-stream";

export const runsRoutes = new Hono<AppEnv>();

runsRoutes.use("*", orgScope);

// Create a run and spawn its actor.
const ENGINES: readonly EngineId[] = ENGINE_IDS;

runsRoutes.post("/", async (c) => {
  let body: {
    prompt?: unknown;
    model?: unknown;
    engine?: unknown;
    parent_run_id?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return c.json({ error: "prompt is required" }, 400);

  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : "claude-opus-5";

  // Engine is optional; default to the scripted `mock`. An explicit unknown
  // value is a client error rather than a silent fallback.
  let engine: EngineId = "mock";
  if (body.engine !== undefined) {
    if (typeof body.engine !== "string" || !ENGINES.includes(body.engine as EngineId)) {
      return c.json(
        { error: `engine must be one of: ${ENGINES.join(", ")}` },
        400,
      );
    }
    engine = body.engine as EngineId;
  }

  const id = crypto.randomUUID();

  // Threading: a reply passes `parent_run_id`. Resolve it org-scoped (a
  // cross-org/missing parent is a 404) and inherit its thread; a root run threads
  // under its own id. The stored prompt stays the user's raw text — the engine
  // context is composed later (worker) by walking the thread, never nested here.
  let parentRunId: string | null = null;
  let threadId: string = id;
  if (body.parent_run_id !== undefined && body.parent_run_id !== null) {
    const rawParent =
      typeof body.parent_run_id === "string" ? body.parent_run_id.trim() : "";
    if (!rawParent) {
      return c.json({ error: "parent_run_id must be a run id string" }, 400);
    }
    const parent = await getRunForOrg(c.get("orgId"), rawParent);
    if (!parent) return c.json({ error: "parent run not found" }, 404);
    parentRunId = parent.id;
    threadId = parent.threadId;
  }

  // Accept the run as a durable command. An `Idempotency-Key` makes a lost-
  // response retry observe the ORIGINAL run instead of starting duplicate work;
  // the un-keyed path behaves exactly as before (new run every call). Empty /
  // whitespace-only keys are treated as absent.
  const idempotencyKey = c.req.header("Idempotency-Key")?.trim() || null;
  const accepted = await acceptRunCommand({
    idempotencyKey,
    orgId: c.get("orgId"),
    actorId: c.get("userId"),
    run: { id, prompt, model, engine, parentRunId, threadId },
  });

  // Same key, different request — refuse to guess which turn the client meant.
  if (accepted.kind === "conflict") {
    return c.json(
      { error: "idempotency_key_reused", detail: "same Idempotency-Key, different request" },
      409,
    );
  }
  // Replay of an already-accepted command: the original run's worker is already
  // running (or finished) — return its id, do NOT re-dispatch.
  if (accepted.kind === "replayed") {
    return c.json({ id: accepted.runId }, 200);
  }

  // Freshly accepted → dispatch: spawn the worker, then mark the command
  // dispatched (audit metadata; the worker owns the run regardless).
  spawnWorker(accepted.runId);
  await markCommandDispatched(accepted.commandId);

  return c.json({ id: accepted.runId }, 201);
});

// List runs (newest first) with their steps, scoped to the active org. By
// default only thread roots (one entry per conversation); `?all=1` returns every
// run in every thread.
runsRoutes.get("/", async (c) =>
  c.json({
    runs: await listRunsWithSteps(c.get("orgId"), {
      all: c.req.query("all") === "1",
    }),
  }),
);

// Single run + steps (scoped to the active org — cross-org id → 404).
// `?thread=1` returns the whole thread the run belongs to, oldest→newest.
runsRoutes.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (c.req.query("thread") === "1") {
    const thread = await getThreadForRun(orgId, id);
    if (!thread) return c.json({ error: "run not found" }, 404);
    return c.json({ thread });
  }
  const run = await getRunWithSteps(orgId, id);
  if (!run) return c.json({ error: "run not found" }, 404);
  return c.json(run);
});

// SSE trace stream: replay existing steps, then live-push new ones.
//
// Built as a raw ReadableStream (not Hono's streamSSE) so we own every response
// header — this is the QM port's key SSE-hygiene requirement: `no-transform` +
// `X-Accel-Buffering: no` to stop proxies buffering/transforming frames. Hono's
// streamSSE hardcodes `Cache-Control: no-cache` and re-merges it over any
// override, so it can't express `no-transform`. Speed comes from delta
// publishing + these anti-buffering headers + immediate enqueue (no compression
// middleware wraps this app — only cors — so nothing buffers the body).
runsRoutes.get("/:id/events", async (c) => {
  const id = c.req.param("id");
  // Authorize by org first — a cross-org (or missing) id is a 404, never a stream.
  if (!(await getRunForOrg(c.get("orgId"), id))) {
    return c.json({ error: "run not found" }, 404);
  }

  // A live assistant-text delta multiplexed onto the SAME queue as bus events,
  // so ALL frames are written by the single drain loop below in order.
  type OutEvent = BusEvent | { type: "delta"; delta: string };
  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // idx → content fingerprint of the LAST version sent. Updates (same idx,
      // enriched code_json) must pass; only true duplicates are suppressed.
      const emitted = new Map<number, string>();
      const queue: OutEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = false;

      const send = (frame: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          /* controller already closed (client gone) */
        }
      };
      const sendEvent = (event: string, data: unknown): void =>
        send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const wakeUp = (): void => {
        if (wake) {
          wake();
          wake = null;
        }
      };
      const push = (ev: OutEvent): void => {
        queue.push(ev);
        wakeUp();
      };
      bus.on(channel(id), push);
      // Live-typing narration: each delta an engine publishes is forwarded as a
      // distinct `event: delta` frame. Old clients (which only listen for `step`
      // / `done`) ignore it — contract-compatible.
      const unsubscribeDeltas = turnStream.subscribe(id, (delta) =>
        push({ type: "delta", delta }),
      );

      // Prime the stream so headers/first bytes flush immediately.
      send(": open\n\n");

      // Heartbeat comment keeps proxies/browsers from dropping an idle stream.
      // unref so it never keeps the process alive on its own.
      const heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
      heartbeat.unref?.();

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        bus.off(channel(id), push);
        unsubscribeDeltas();
        signal.removeEventListener("abort", cleanup);
        wakeUp();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      if (signal.aborted) return cleanup();
      signal.addEventListener("abort", cleanup);

      // Drive replay + the live loop OUTSIDE start() so the response streams
      // immediately (start resolving isn't gated on the whole run finishing).
      void (async () => {
        // Replay everything already persisted (subscribed first, so no gap).
        for (const step of await getStepsApi(id)) {
          if (closed) return;
          emitted.set(step.idx, `${step.id}|${step.code_json ?? ""}`);
          sendEvent("step", step);
        }

        // If the run already finished, close immediately after replay.
        const snapshot = await getRun(id);
        if (snapshot && (snapshot.status === "completed" || snapshot.status === "failed")) {
          sendEvent("done", { id, status: snapshot.status });
          return cleanup();
        }

        // Live loop.
        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          while (queue.length > 0 && !closed) {
            const ev = queue.shift()!;
            if (ev.type === "step") {
              // Same idx may arrive again with enriched code_json (tool output
              // attached in place) — forward it; skip only true duplicates.
              const fp = `${ev.step.id}|${ev.step.code_json ?? ""}`;
              if (emitted.get(ev.step.idx) === fp) continue;
              emitted.set(ev.step.idx, fp);
              sendEvent("step", ev.step);
            } else if (ev.type === "delta") {
              sendEvent("delta", { delta: ev.delta });
            } else {
              sendEvent("done", { id, status: ev.status });
              return cleanup();
            }
          }
        }
      })();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
