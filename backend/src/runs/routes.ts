import { Hono } from "hono";
import type { AppEnv } from "../http";
import { ENGINE_IDS, MEMORY_SCOPES, type EngineId, type MemoryScope } from "../db/schema";
import { isMemoryScope } from "../memory/scope";
import { orgScope } from "../middleware/org";
import {
  getRun,
  getRunForOrg,
  getRunWithSteps,
  getStepsApi,
  getThreadForRun,
  listRunsWithSteps,
} from "./repo";
import { acceptRunCommand } from "../commands";
import { acceptRunCancel, CANCEL_SUMMARY } from "../commands/cancel";
import { resolveSkillSelection } from "../skills/repo";
import { unknownRepos } from "../github/repos";
import { formatRepoRef } from "../github/repo-ref";
import { bus, channel, pumpThread, signalCancel, type BusEvent } from "../worker";
import { turnStream } from "./turn-stream";
import { assertNever } from "../util/exhaustive";
import {
  getNativeFramesSince,
  subscribeNative,
  type NativeFrame,
} from "./native-events";

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
    repo?: unknown;
    repos?: unknown;
    branches?: unknown;
    memory_scope?: unknown;
    skill?: unknown;
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
  let inheritedRepos: string[] = [];
  let parentScope: MemoryScope | null = null;
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
    inheritedRepos = parent.repos;
    parentScope = parent.memoryScope;
  }

  // Repo scope: a ROOT run may pick REPOSITORIES (each validated against the set
  // GET /api/repos actually offers — an unknown/malformed value is a client
  // error, never silently dropped). A REPLY inherits its thread's repos (the
  // sandbox already holds the clones) and ignores any repos in its own body.
  // Accepts `repos: string[]` (preferred) or a single `repo` string (back-compat),
  // plus an optional `branches: { "owner/name": branch }` map — a repo with no
  // entry (or a bare payload) clones its default branch. The chosen branch is
  // encoded onto the stored ref (see repo-ref.ts) so replay/reconnect clones the
  // SAME branch; the validated set stays clean "owner/name".
  let repos: string[] = [];
  if (parentRunId) {
    repos = inheritedRepos;
  } else {
    const raw = Array.isArray(body.repos)
      ? body.repos
      : body.repo !== undefined && body.repo !== null
        ? [body.repo]
        : [];
    const wanted = [
      ...new Set(
        raw.map((r) => (typeof r === "string" ? r.trim() : "")).filter((r) => r.length > 0),
      ),
    ];
    if (wanted.length > 0) {
      const unknown = await unknownRepos(wanted);
      if (unknown.length > 0) {
        return c.json(
          { error: `repos not in the available set: ${unknown.join(", ")}` },
          400,
        );
      }
      const branchMap =
        body.branches && typeof body.branches === "object" && !Array.isArray(body.branches)
          ? (body.branches as Record<string, unknown>)
          : {};
      repos = wanted.map((r) => {
        const b = branchMap[r];
        return formatRepoRef(r, typeof b === "string" ? b : null);
      });
    }
  }

  // Memory scope: an explicit choice from the authenticated user (validated) wins;
  // otherwise a reply INHERITS its parent's scope and a root run defaults to "org".
  // ONLY the scope enum is read from the body — never any identity (org/user is
  // always server-resolved). An unknown value is a client error, not a fallback.
  let memoryScope: MemoryScope;
  if (body.memory_scope !== undefined && body.memory_scope !== null) {
    if (!isMemoryScope(body.memory_scope)) {
      return c.json(
        { error: `memory_scope must be one of: ${MEMORY_SCOPES.join(", ")}` },
        400,
      );
    }
    memoryScope = body.memory_scope;
  } else {
    memoryScope = parentScope ?? "org";
  }

  // Skill pinning: an optional `{ id, version? }` selects a versioned skill. It is
  // resolved ORG-SCOPED and FAIL-CLOSED — an unknown skill, a cross-org id, or a
  // bad version is a 400, never a silent no-skill run. The run stores an immutable
  // (id + version + hash) reference so a later skill edit can't change what this
  // run loaded; the worker materializes the pinned revision into the engine's
  // context separately from the clean prompt and emits `skill.loaded`.
  let skillId: string | null = null;
  let skillVersion: number | null = null;
  let skillContentHash: string | null = null;
  if (body.skill !== undefined && body.skill !== null) {
    const sel = body.skill as { id?: unknown; version?: unknown };
    const rawId = typeof sel.id === "string" ? sel.id.trim() : "";
    if (!rawId) {
      return c.json({ error: "skill.id must be a skill id string" }, 400);
    }
    const version =
      typeof sel.version === "number" &&
      Number.isInteger(sel.version) &&
      sel.version > 0
        ? sel.version
        : undefined;
    const pinned = await resolveSkillSelection(c.get("orgId"), { id: rawId, version });
    if (!pinned) {
      return c.json({ error: "skill not found in this org (or unknown version)" }, 400);
    }
    skillId = pinned.skillId;
    skillVersion = pinned.version;
    skillContentHash = pinned.contentHash;
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
    run: { id, prompt, model, engine, parentRunId, threadId, repos, memoryScope, skillId, skillVersion, skillContentHash },
  });

  // Translate the acceptance outcome to the HTTP response (exhaustive — a new
  // outcome variant is a compile error here).
  switch (accepted.status) {
    case "created":
      // Enqueued durably; pump the thread's mailbox — dispatches this run now if
      // the thread is idle, else it waits its turn (survives a restart).
      await pumpThread(threadId);
      return c.json({ id: accepted.runId }, 201);
    case "replayed":
      // The original run's worker is already running (or finished) — return its
      // id, do NOT re-dispatch.
      return c.json({ id: accepted.runId }, 200);
    case "conflict":
      return c.json(
        { error: "idempotency_key_reused", reason: accepted.reason },
        409,
      );
    default:
      return assertNever(accepted);
  }
});

// POST /:id/cancel — durable user Stop. Records a `run.cancel` command
// (idempotent), fails a not-yet-started (queued) run atomically, signals a live
// actor to abort, and pumps the thread so the QUEUED lane continues. Org-scoped
// (a cross-org/missing id is a 404). A run that already settled is a no-op.
runsRoutes.post("/:id/cancel", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const outcome = await acceptRunCancel({ orgId, actorId: c.get("userId"), runId: id });
  switch (outcome.status) {
    case "not_found":
      return c.json({ error: "run not found" }, 404);
    case "terminal":
      return c.json({ id, status: outcome.runStatus, note: "already settled" }, 200);
    case "already":
      // Idempotent replay — best-effort re-signal a still-live actor, then pump.
      signalCancel(id, CANCEL_SUMMARY);
      await pumpThread(outcome.threadId);
      return c.json({ id, status: "cancelling" }, 200);
    case "accepted":
      // A RUNNING actor is aborted in-process (its teardown finalizes the run
      // "Stopped by user" and pumps); a QUEUED run was already failed in-tx.
      // Pump either way so the next queued turn dispatches.
      if (outcome.runStatusWas === "running") signalCancel(id, CANCEL_SUMMARY);
      await pumpThread(outcome.threadId);
      return c.json({ id, status: "cancelling" }, 202);
    default:
      return assertNever(outcome);
  }
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

  // A live assistant-text delta AND a versioned native frame are multiplexed
  // onto the SAME queue as bus events, so ALL frames are written by the single
  // drain loop below in order.
  type OutEvent =
    | BusEvent
    | { type: "delta"; delta: string }
    | { type: "native"; frame: NativeFrame };
  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;

  // Native-frame lane cursor: replay lossless native events with seq strictly
  // greater than `?cursor=` (default -1 → from the start; seq begins at 0). A
  // malformed cursor is ignored (treated as absent) rather than erroring.
  const cursorRaw = c.req.query("cursor");
  const cursorSeq = cursorRaw !== undefined && Number.isFinite(Number(cursorRaw))
    ? Number(cursorRaw)
    : -1;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // idx → content fingerprint of the LAST version sent. Updates (same idx,
      // enriched code_json) must pass; only true duplicates are suppressed.
      const emitted = new Map<number, string>();
      // Native-frame dedupe: eventId → the highest seq already sent. A revision
      // (same eventId, higher seq) passes; a replay/live overlap is suppressed.
      const nativeSeen = new Map<string, number>();
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
      // Live native frames (lossless capture projection). Old clients ignore the
      // `event: native` type — additive, contract-compatible.
      const unsubscribeNative = subscribeNative(id, (frame) =>
        push({ type: "native", frame }),
      );

      // Emit a native frame if it advances its eventId's seq (dedupe overlap).
      const sendNative = (frame: NativeFrame): void => {
        if ((nativeSeen.get(frame.eventId) ?? -1) >= frame.seq) return;
        nativeSeen.set(frame.eventId, frame.seq);
        sendEvent("native", frame);
      };

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
        unsubscribeNative();
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

        // Replay the native lane from the client's cursor (ordered by seq;
        // already deduped by native id in the store). Subscribed before this, so
        // a frame persisted during replay arrives on the live queue and the
        // seq-dedupe suppresses the overlap.
        for (const frame of await getNativeFramesSince(id, cursorSeq)) {
          if (closed) return;
          sendNative(frame);
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
            switch (ev.type) {
              case "step": {
                // Same idx may arrive again with enriched code_json (tool output
                // attached in place) — forward it; skip only true duplicates.
                const fp = `${ev.step.id}|${ev.step.code_json ?? ""}`;
                if (emitted.get(ev.step.idx) === fp) continue;
                emitted.set(ev.step.idx, fp);
                sendEvent("step", ev.step);
                continue;
              }
              case "delta":
                sendEvent("delta", { delta: ev.delta });
                continue;
              case "native":
                sendNative(ev.frame);
                continue;
              case "end":
                sendEvent("done", { id, status: ev.status });
                return cleanup();
              default:
                assertNever(ev);
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
