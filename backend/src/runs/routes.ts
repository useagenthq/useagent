import { Hono } from "hono";
import type { AppEnv } from "../http";
import {
  ENGINE_IDS,
  MEMORY_SCOPES,
  type EngineId,
  type MemoryScope,
  type RunStatus,
} from "../db/schema";
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
import {
  acceptRunCommand,
  preflightRunCommandReplay,
  RunAdmissionClosedError,
  type RunCommandIntent,
} from "../commands";
import { acceptRunCancel, CANCEL_SUMMARY } from "../commands/cancel";
import { finalizeRun } from "./finalize";
import { deleteReconcile } from "./reconcile-queue";
import { resolveSkillSelection } from "../skills/repo";
import { buildNativeCommandPrompt, validateCommandIntent, type CommandIntent } from "./command-intent";
import { readSessionCommandCatalog } from "./command-catalog";
import { formatRepoRef } from "../github/repo-ref";
import { createRunResourceAuthorization } from "../resources/authorization";
import {
  explicitRepositoryResources,
  legacyParentResources,
  resolveRunIntake,
  RunIntakeError,
  type RunResource,
} from "../resources/run-intake";
import { bus, channel, pumpThread, signalCancel, type BusEvent } from "../worker";
import { turnStream, type DeltaKind } from "./turn-stream";
import { assertNever } from "../util/exhaustive";
import {
  getNativeFramesSince,
  subscribeNative,
  type NativeFrame,
} from "./native-events";
import {
  loadCanonicalThread,
  subscribeCanonicalThread,
  subscribeCanonicalizationComplete,
  type CanonicalizationComplete,
  type DeliveredCanonicalEvent,
} from "./canonical-events";
import { completeCanonicalRuns } from "./canonicalization-outbox";
import { subscribeThread } from "./thread-signals";
import { clientOrgChangeForUser, subscribeOrg } from "./org-signals";
import type { ApiRun, ApiStep } from "./repo";
import { defaultModelForEngine, isModelAllowedForEngine } from "./model-policy";
import {
  engineResolutionErrorBody,
  modelProviderReadyForEngine,
  resolveAcceptedEngine,
} from "./engine-readiness";
import { getRunTimingTable } from "./run-timing";
import {
  OpenCodeQuestionError,
  replyToOpenCodeQuestion,
} from "../engines/opencode-question";
import { releaseRunSandbox } from "./sandbox-release";
import { isRuntimeThreadSessionId } from "../engines/runtime-orchestration";
import { replyToRuntimeQuestion } from "../engines/runtime-question";
import { strictOrgSecretRedactor } from "../secrets/store";
import { replyToRuntimeApproval, RuntimeApprovalError } from "../engines/runtime-approval";
import { listUploadsForRuns, UploadClaimError } from "../uploads/repo";

export const runsRoutes = new Hono<AppEnv>();

runsRoutes.use("*", orgScope);

// One lightweight, tenant-scoped invalidation stream for ambient product
// surfaces (Workspace, Runs, Recents, Artifacts). The database remains the
// source of truth: events carry IDs only and tell clients which snapshot to
// refresh. The active conversation keeps its richer thread-events stream.
runsRoutes.get("/changes", (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (frame: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          cleanup();
        }
      };
      const unsubscribe = subscribeOrg(orgId, (change) => {
        const clientChange = clientOrgChangeForUser(change, userId);
        if (!clientChange) return;
        send(`event: change\ndata: ${JSON.stringify(clientChange)}\n\n`);
      });
      const heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
      heartbeat.unref?.();

      function cleanup(): void {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // The browser may already have closed the stream.
        }
      }

      send(": open\nretry: 1500\n\n");
      if (signal.aborted) cleanup();
      else signal.addEventListener("abort", cleanup);
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
    command?: unknown;
    attachments?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return c.json({ error: "prompt is required" }, 400);

  const rawAttachments = body.attachments ?? [];
  if (!Array.isArray(rawAttachments) || rawAttachments.length > 10) {
    return c.json({ error: "attachments must be an array of at most 10 upload ids" }, 400);
  }
  const attachmentIds = [...new Set(rawAttachments)];
  if (
    attachmentIds.some(
      (id) =>
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
    )
  ) {
    return c.json({ error: "attachments contain an invalid upload id" }, 400);
  }
  if (attachmentIds.length > 0 && !c.get("userId")) {
    return c.json({ error: "authenticated user required for attachments" }, 401);
  }

  const requestedModel =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : null;
  let requestedEngine: EngineId | null = null;
  if (body.engine !== undefined && body.engine !== null && body.engine !== "") {
    if (
      typeof body.engine !== "string" ||
      !(ENGINE_IDS as readonly string[]).includes(body.engine)
    ) {
      return c.json({ error: `engine must be one of: ${ENGINE_IDS.join(", ")}` }, 400);
    }
    requestedEngine = body.engine as EngineId;
  }

  const id = crypto.randomUUID();

  // Threading: a reply passes `parent_run_id`. Resolve it org-scoped (a
  // cross-org/missing parent is a 404) and inherit its thread; a root run threads
  // under its own id. The stored prompt stays the user's raw text — the engine
  // context is composed later (worker) by walking the thread, never nested here.
  let parentRunId: string | null = null;
  let threadId: string = id;
  let inheritedRepos: string[] = [];
  let inheritedResources: readonly RunResource[] = [];
  let parentScope: MemoryScope | null = null;
  let parentModel: string | null = null;
  let parentEngine: EngineId | null = null;
  // The ACTIVE native session this turn resumes, derived SERVER-SIDE from the parent run (a
  // reply resumes the thread's live session). A native-command intent's client-supplied session
  // id is validated against THIS, never trusted on its own.
  let activeSessionId: string | null = null;
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
    inheritedResources =
      parent.resolvedResources.length > 0
        ? parent.resolvedResources
        : legacyParentResources(parent.repos, "web");
    parentScope = parent.memoryScope;
    parentModel = parent.model;
    parentEngine = parent.engine;
    activeSessionId = parent.engineSessionId ?? null;
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
  let requestedRepos: string[] = [];
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
      const branchMap =
        body.branches && typeof body.branches === "object" && !Array.isArray(body.branches)
          ? (body.branches as Record<string, unknown>)
          : {};
      requestedRepos = wanted.map((r) => {
        const b = branchMap[r];
        return formatRepoRef(r, typeof b === "string" ? b : null);
      });
      repos = requestedRepos;
    }
  }

  // Memory scope: an explicit choice from the authenticated user (validated) wins;
  // otherwise a reply INHERITS its parent's scope and a root run defaults to "org".
  // ONLY the scope enum is read from the body — never any identity (org/user is
  // always server-resolved). An unknown value is a client error, not a fallback.
  let memoryScope: MemoryScope;
  let requestedMemoryScope: MemoryScope | null = null;
  if (body.memory_scope !== undefined && body.memory_scope !== null) {
    if (!isMemoryScope(body.memory_scope)) {
      return c.json(
        { error: `memory_scope must be one of: ${MEMORY_SCOPES.join(", ")}` },
        400,
      );
    }
    requestedMemoryScope = body.memory_scope;
    memoryScope = requestedMemoryScope;
  } else {
    memoryScope = parentScope ?? "org";
  }

  // Parse the stable skill selection before the replay lookup. Its mutable
  // org-scoped revision is resolved only for a genuinely new acceptance below.
  let skillId: string | null = null;
  let skillVersion: number | null = null;
  let skillContentHash: string | null = null;
  let requestedSkillId: string | null = null;
  let requestedSkillVersion: number | null = null;
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
    requestedSkillId = rawId;
    requestedSkillVersion = version ?? null;
  }

  // Parse the typed native-command request without authorizing it yet. Building
  // its intended provider prompt is pure and preserves the exact argument bytes,
  // so an accepted replay can be identified even if the live session/catalog is
  // later gone. A first acceptance still validates the live catalog below.
  let finalPrompt = prompt;
  let commandName: string | null = null;
  // The ACCEPTED command identity persisted with the durable run (not just the name): which
  // provider, native session, and catalog snapshot authorized it - so the worker can re-validate
  // against the LIVE session before sending, and history records exactly what was authorized.
  let commandProvider: string | null = null;
  let commandSessionId: string | null = null;
  let commandCatalogRevision: number | null = null;
  let requestedCommand: CommandIntent | null = null;
  if (body.command !== undefined && body.command !== null) {
    const raw = body.command as { name?: unknown; args?: unknown; provider?: unknown; sessionId?: unknown; catalogRevision?: unknown };
    requestedCommand = {
      name: typeof raw.name === "string" ? raw.name : "",
      args: typeof raw.args === "string" ? raw.args : undefined,
      provider: typeof raw.provider === "string" ? raw.provider : undefined,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
      catalogRevision: typeof raw.catalogRevision === "number" ? raw.catalogRevision : undefined,
    };
    finalPrompt = buildNativeCommandPrompt(
      requestedCommand.name.trim(),
      requestedCommand.args,
    );
  }

  const idempotencyKey = c.req.header("Idempotency-Key")?.trim() || null;
  const intent: RunCommandIntent = {
    prompt: finalPrompt,
    model: requestedModel,
    engine: requestedEngine,
    parentRunId,
    requestedRepos,
    attachmentIds,
    memoryScope: requestedMemoryScope,
    skillId: requestedSkillId,
    skillVersion: requestedSkillVersion,
    commandName: requestedCommand?.name.trim() || null,
    commandProvider: requestedCommand?.provider ?? null,
    commandSessionId: requestedCommand?.sessionId ?? null,
    commandCatalogRevision: requestedCommand?.catalogRevision ?? null,
  };
  let replay;
  try {
    replay = await preflightRunCommandReplay({
      orgId: c.get("orgId"),
      idempotencyKey,
      intent,
    });
  } catch (error) {
    if (error instanceof RunAdmissionClosedError) {
      return c.json({ error: error.code, retryable: true }, 503);
    }
    throw error;
  }
  if (replay?.status === "replayed") {
    return c.json({ id: replay.runId }, 200);
  }
  if (replay?.status === "conflict") {
    return c.json({ error: "idempotency_key_reused", reason: replay.reason }, 409);
  }

  // Everything below is mutable authorization/readiness state and therefore
  // applies only to first acceptance. Matching durable replays returned above.
  if (parentEngine && requestedEngine && requestedEngine !== parentEngine) {
    return c.json({ error: "reply_engine_mismatch", engine: parentEngine }, 400);
  }
  const resolvedEngine = resolveAcceptedEngine(parentEngine ?? requestedEngine);
  if (!resolvedEngine.ok) {
    return c.json(engineResolutionErrorBody(resolvedEngine), resolvedEngine.status);
  }
  const engine = resolvedEngine.engine;
  const inheritedModel =
    parentModel && isModelAllowedForEngine(engine, parentModel)
      ? parentModel
      : defaultModelForEngine(engine);
  const model = requestedModel ?? inheritedModel;
  if (!isModelAllowedForEngine(engine, model)) {
    return c.json({ error: "model_not_allowed", engine, model }, 400);
  }
  if (!modelProviderReadyForEngine(engine, model)) {
    return c.json({ error: "model_provider_not_ready", engine, model }, 403);
  }

  if (requestedSkillId) {
    const pinned = await resolveSkillSelection(c.get("orgId"), {
      id: requestedSkillId,
      version: requestedSkillVersion ?? undefined,
    });
    if (!pinned) {
      return c.json({ error: "skill not found in this org (or unknown version)" }, 400);
    }
    skillId = pinned.skillId;
    skillVersion = pinned.version;
    skillContentHash = pinned.contentHash;
  }

  if (requestedCommand) {
    if (!requestedCommand.provider || requestedCommand.provider !== engine) {
      return c.json({ error: "invalid_command", reason: "provider does not match engine" }, 400);
    }
    const sessionCatalog = activeSessionId
      ? await readSessionCommandCatalog(threadId, engine, activeSessionId)
      : null;
    const validated = validateCommandIntent(
      requestedCommand,
      sessionCatalog?.commands ?? [],
      {
        sessionId: activeSessionId,
        revision: sessionCatalog?.revision ?? null,
      },
    );
    if (!validated.ok) {
      return c.json({ error: "invalid_command", reason: validated.reason }, 400);
    }
    commandName = validated.name;
    commandProvider = requestedCommand.provider;
    commandSessionId = activeSessionId;
    commandCatalogRevision = sessionCatalog?.revision ?? null;
    finalPrompt = buildNativeCommandPrompt(validated.name, validated.args);
  }

  let resolvedResources: readonly RunResource[];
  try {
    const intake = await resolveRunIntake(
      {
        source: "web",
        // Native provider commands are control traffic. Their argument bytes
        // are delivered verbatim and never widen the run's resource scope.
        text: commandName ? "" : prompt,
        explicitResources: parentRunId
          ? []
          : explicitRepositoryResources(repos),
        inheritedResources,
      },
      { authorize: createRunResourceAuthorization(c.get("orgId")) },
    );
    repos = [...intake.repos];
    resolvedResources = intake.resources;
  } catch (error) {
    if (error instanceof RunIntakeError) {
      return c.json(
        { error: error.code, ...error.diagnostic },
        error.code === "resource_unauthorized" ? 403 : 400,
      );
    }
    throw error;
  }

  // Accept the run as a durable command. An `Idempotency-Key` makes a lost-
  // response retry observe the ORIGINAL run instead of starting duplicate work;
  // the un-keyed path behaves exactly as before (new run every call). Empty /
  // whitespace-only keys are treated as absent.
  let accepted;
  try {
    accepted = await acceptRunCommand({
      idempotencyKey,
      orgId: c.get("orgId"),
      actorId: c.get("userId"),
      intent,
      run: { id, prompt: finalPrompt, model, engine, parentRunId, threadId, repos, resolvedResources, attachmentIds, memoryScope, skillId, skillVersion, skillContentHash, commandName, commandProvider, commandSessionId, commandCatalogRevision },
    });
  } catch (error) {
    if (error instanceof UploadClaimError) {
      return c.json({ error: "upload_unavailable" }, 409);
    }
    if (error instanceof RunAdmissionClosedError) {
      return c.json({ error: error.code, retryable: true }, 503);
    }
    throw error;
  }

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
      // Pump either way so the next queued turn dispatches. Do NOT pretend a live
      // process was signalled when it was not: a run the DB marks running but with no
      // live canceller (e.g. after a crash) has its cancel recorded durably above and
      // reconciled by recovery - surface the gap instead of hiding it.
      if (outcome.runStatusWas === "running") {
        const signalled = signalCancel(id, CANCEL_SUMMARY);
        if (!signalled) {
          // ZOMBIE: the DB says running but no actor in this process owns the
          // run - its engine died with a restart. The user said stop; honor it
          // NOW instead of waiting on the reconcile re-probe (a user sat on a
          // dead "Send now" for 25 minutes this way, 2026-08-20). Finalize as
          // stopped, drop any parked re-probe, and let the pump promote the
          // queue. finalizeRun is idempotent against a concurrent settle.
          console.warn(
            `[cancel] run ${id} is 'running' with no live canceller; finalizing as stopped now.`,
          );
          await finalizeRun(id, "failed", CANCEL_SUMMARY, 0);
          await deleteReconcile(id);
        }
      }
      await pumpThread(outcome.threadId);
      return c.json({ id, status: "cancelling" }, 202);
    default:
      return assertNever(outcome);
  }
});

// Resolve a native provider Question request IN the currently-running turn.
// This is control traffic, not a new user turn: answering must unblock the
// resident session rather than enqueue another run behind the blocked one.
runsRoutes.post("/:id/questions/:questionId/reply", async (c) => {
  const run = await getRunForOrg(c.get("orgId"), c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const runtimeSession = isRuntimeThreadSessionId(run.engineSessionId ?? "");
  if (!runtimeSession && run.engine !== "opencode") {
    return c.json({ error: "questions_not_supported", engine: run.engine }, 409);
  }
  if (run.status !== "running" || !run.engineSessionId) {
    return c.json({ error: "question_session_not_active" }, 409);
  }
  let body: { answers?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  try {
    const reply = runtimeSession ? replyToRuntimeQuestion : replyToOpenCodeQuestion;
    const redact = await strictOrgSecretRedactor(run.orgId);
    const result = await reply({
      runId: run.id,
      threadId: run.threadId,
      sessionId: run.engineSessionId,
      questionId: c.req.param("questionId"),
      answers: body.answers,
      signal: c.req.raw.signal,
      redact,
    });
    return c.json({ ok: true, already_answered: result.alreadyAnswered });
  } catch (error) {
    if (error instanceof OpenCodeQuestionError) {
      return c.json({ error: error.code, message: error.message }, error.status);
    }
    console.error(`[question] reply failed for run ${run.id}:`, error);
    return c.json({ error: "question_reply_failed" }, 502);
  }
});

// Resolve a native provider approval inside the active turn. The response is
// dispatched to the runtime resident provider session and durably recorded before the
// UI considers the approval closed.
runsRoutes.post("/:id/approvals/:requestId/reply", async (c) => {
  const run = await getRunForOrg(c.get("orgId"), c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  if (
    run.status !== "running" ||
    !run.engineSessionId ||
    !isRuntimeThreadSessionId(run.engineSessionId)
  ) {
    return c.json({ error: "approval_session_not_active" }, 409);
  }
  let body: { decision?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  try {
    const result = await replyToRuntimeApproval({
      runId: run.id,
      threadId: run.threadId,
      sessionId: run.engineSessionId,
      requestId: c.req.param("requestId"),
      decision: body.decision,
      signal: c.req.raw.signal,
    });
    return c.json({ ok: true, already_answered: result.alreadyAnswered });
  } catch (error) {
    if (error instanceof RuntimeApprovalError) {
      return c.json({ error: error.code, message: error.message }, error.status);
    }
    console.error(`[approval] reply failed for run ${run.id}:`, error);
    return c.json({ error: "approval_reply_failed" }, 502);
  }
});

// Explicit eval/test cleanup. Product threads remain warm by default; callers
// release only when they no longer need resume state. Org scope + active-run
// checks prevent cross-tenant deletion or tearing down a live turn.
runsRoutes.delete("/:id/sandbox", async (c) => {
  const result = await releaseRunSandbox(c.get("orgId"), c.req.param("id"));
  if (!result.ok) {
    if (result.reason === "not_found") return c.json({ error: "run not found" }, 404);
    if (result.reason === "thread_active") return c.json({ error: "thread is active" }, 409);
    return c.json({ error: "sandbox release failed" }, 502);
  }
  return c.json(result);
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

// A run's INBOUND attachments (Slack files / browser uploads the user sent with
// the turn). Org-scoped: a cross-org (or missing) run id is a 404. The compact
// list also rides the run/thread payload (repo.ts), so the timeline needs no
// extra round trip; this route exists for callers that want it standalone.
runsRoutes.get("/:id/uploads", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (!(await getRunForOrg(orgId, id))) return c.json({ error: "run not found" }, 404);
  const uploads = (await listUploadsForRuns([id])).get(id) ?? [];
  return c.json({ uploads });
});

// Per-run developer timing table (perf plan Phase 0): the run's recorded stage
// spans/marks plus dispatch-to-first-provider-event, derived from the durable
// timing rows. Diagnostics only - numbers and stage names, nothing sensitive.
runsRoutes.get("/:id/timings", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  if (!(await getRunForOrg(orgId, id))) return c.json({ error: "run not found" }, 404);
  const table = await getRunTimingTable(id);
  return c.json(table);
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
    | { type: "delta"; delta: string; kind?: DeltaKind }
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
      const unsubscribeDeltas = turnStream.subscribe(id, (delta, kind) =>
        push({ type: "delta", delta, kind }),
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
                sendEvent("delta", { delta: ev.delta, kind: ev.kind });
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

// ADDITIVE thread SSE stream (final_fix.md): ONE realtime subscription for a whole
// Skynet conversation, keyed by the ROOT run id in the URL — not whichever run
// happens to be selected. It is a READ/AGGREGATION boundary over the EXISTING
// durable sources (runs/steps via getThreadForRun, provider_events via the native
// lane) and the EXISTING live buses (worker bus, turn-stream deltas, native bus),
// multiplexing every run in the thread onto one connection. It is NOT a second
// execution system and NOT a new source of truth.
//
// Frame contract (each `event:` type; every non-snapshot frame identifies its run):
//   snapshot { threadId, runs }            authoritative full thread (durable steps)
//   run      { threadId, run }             one run upserted (new/queued/running/settled)
//   step     { threadId, runId, step }     durable step upsert (same idx enriches)
//   delta    { threadId, runId, delta }    transient live narration
//   native   { threadId, runId, frame }    versioned native frame (dedupe by eventId+seq)
//   done     { threadId, runId, status }   settles ONE run; does NOT close the stream
//
// Reconnect replays a full snapshot + latest native frames per run; stable ids make
// that idempotent (no thread-global sequence — deliberately simpler, correct at this
// scale). The old per-run `/:id/events` route is untouched (the rollback path).
//
// A cap of MAX_QUEUE queued live frames bounds memory: on overflow the connection
// closes so the browser reconnects to a fresh authoritative snapshot rather than
// growing without limit.
const MAX_QUEUE = 20_000;

runsRoutes.get("/:rootRunId/thread-events", async (c) => {
  const orgId = c.get("orgId");
  const rootRunId = c.req.param("rootRunId");

  // Resolve + authorize the root run and derive the canonical threadId SERVER-SIDE
  // BEFORE opening any stream. A cross-org or missing id is a 404, indistinguishable
  // from non-existence — never trust a browser-supplied threadId/orgId.
  const rootRun = await getRunForOrg(orgId, rootRunId);
  if (!rootRun) return c.json({ error: "run not found" }, 404);
  const threadId = rootRun.threadId;

  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;

  type ThreadOut =
    | { type: "signal"; runId: string }
    | { type: "step"; runId: string; step: ApiStep }
    | { type: "end"; runId: string; status: RunStatus }
    | { type: "delta"; runId: string; delta: string; kind?: DeltaKind }
    | { type: "native"; runId: string; frame: NativeFrame }
    | { type: "canonical"; event: DeliveredCanonicalEvent }
    | { type: "canonical-complete"; complete: CanonicalizationComplete };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const queue: ThreadOut[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      let overflowed = false;

      // Per-run dedupe state (keyed by runId): step idx→content fingerprint, and
      // native eventId→highest seq. Mirrors the per-run route's dedupe, one map
      // per run so replay/live overlap collapses without cross-run interference.
      const emittedByRun = new Map<string, Map<number, string>>();
      const nativeSeenByRun = new Map<string, Map<string, number>>();
      // Per-run live-source listeners, torn down together on disconnect.
      const attached = new Set<string>();
      const perRunCleanups = new Map<string, () => void>();

      const send = (frame: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          /* controller already closed (client gone) */
        }
      };
      const sendFrame = (event: string, data: unknown): void =>
        send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const wakeUp = (): void => {
        if (wake) {
          wake();
          wake = null;
        }
      };
      const push = (ev: ThreadOut): void => {
        if (closed) return;
        if (queue.length >= MAX_QUEUE) {
          // Bound memory: drop the connection so the browser reconnects to a fresh
          // authoritative snapshot instead of buffering without limit.
          overflowed = true;
          cleanup();
          return;
        }
        queue.push(ev);
        wakeUp();
      };

      // Attach the EXISTING per-run live sources for one run (idempotent). The
      // worker step/end bus, the transient delta stream, and the native bus are all
      // relayed with the run's id; a settled run stays attached (late native
      // revisions still land) until the browser disconnects.
      const attachRun = (runId: string): void => {
        if (attached.has(runId)) return;
        attached.add(runId);
        const onBus = (ev: BusEvent): void => {
          if (ev.type === "step") push({ type: "step", runId, step: ev.step });
          else push({ type: "end", runId, status: ev.status });
        };
        bus.on(channel(runId), onBus);
        const offDelta = turnStream.subscribe(runId, (delta, kind) =>
          push({ type: "delta", runId, delta, kind }),
        );
        const offNative = subscribeNative(runId, (frame) =>
          push({ type: "native", runId, frame }),
        );
        perRunCleanups.set(runId, () => {
          bus.off(channel(runId), onBus);
          offDelta();
          offNative();
        });
      };

      // Emit a step if its (idx, fingerprint) is new or enriched (same idx with new
      // code_json passes; a pure duplicate is suppressed).
      const sendStep = (runId: string, step: ApiStep): void => {
        let m = emittedByRun.get(runId);
        if (!m) {
          m = new Map();
          emittedByRun.set(runId, m);
        }
        const fp = `${step.id}|${step.code_json ?? ""}`;
        if (m.get(step.idx) === fp) return;
        m.set(step.idx, fp);
        sendFrame("step", { threadId, runId, step });
      };
      const seedStepDedupe = (runId: string, steps: readonly ApiStep[]): void => {
        let m = emittedByRun.get(runId);
        if (!m) {
          m = new Map();
          emittedByRun.set(runId, m);
        }
        for (const s of steps) m.set(s.idx, `${s.id}|${s.code_json ?? ""}`);
      };

      // Emit a native frame if it advances its eventId's seq (dedupe replay/live).
      const sendNative = (runId: string, frame: NativeFrame): void => {
        let m = nativeSeenByRun.get(runId);
        if (!m) {
          m = new Map();
          nativeSeenByRun.set(runId, m);
        }
        if ((m.get(frame.eventId) ?? -1) >= frame.seq) return;
        m.set(frame.eventId, frame.seq);
        sendFrame("native", { threadId, runId, frame });
      };

      // Canonical lane (final_harness Phase 1): the provider-neutral events, deduped
      // by the IMMUTABLE thread delivery cursor - replay + live never re-send a cursor.
      // Thread-scoped (threadId was authorized at route entry), so no per-run attach.
      let canonicalCursor = 0;
      const sendCanonical = (event: DeliveredCanonicalEvent): void => {
        if (event.deliverySeq <= canonicalCursor) return;
        canonicalCursor = event.deliverySeq;
        sendFrame("canonical", { threadId, event });
      };
      // Canonicalization-complete (H2): the per-run signal that its canonical projection
      // is trustworthy. Deduped per run so replay + live never re-announce a run.
      const canonicalCompleteSeen = new Set<string>();
      const sendCanonicalComplete = (complete: CanonicalizationComplete): void => {
        if (canonicalCompleteSeen.has(complete.runId)) return;
        canonicalCompleteSeen.add(complete.runId);
        sendFrame("canonical-complete", { threadId, complete });
      };

      // Prime headers/first bytes.
      send(": open\n\n");
      const heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
      heartbeat.unref?.();

      function cleanup(): void {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribeThread();
        unsubscribeCanonical();
        unsubscribeCanonicalComplete();
        for (const off of perRunCleanups.values()) off();
        perRunCleanups.clear();
        attached.clear();
        signal.removeEventListener("abort", cleanup);
        wakeUp();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      // Subscribe to the thread-change signal BEFORE loading the snapshot, so a run
      // accepted mid-load is discovered (no window where a new run is missed). The
      // handler only enqueues; the async drain re-reads durable state.
      const unsubscribeThread = subscribeThread(threadId, (change) =>
        push({ type: "signal", runId: change.runId }),
      );
      // Live canonical events for the whole thread (all runs, incl. later ones).
      const unsubscribeCanonical = subscribeCanonicalThread(threadId, (event) =>
        push({ type: "canonical", event }),
      );
      // Live canonicalization-complete signals (one per run as its outbox reaches complete).
      const unsubscribeCanonicalComplete = subscribeCanonicalizationComplete(threadId, (complete) =>
        push({ type: "canonical-complete", complete }),
      );

      if (signal.aborted) return cleanup();
      signal.addEventListener("abort", cleanup);

      // Reload one run's durable projection and emit it as a `run` frame, ensuring
      // its live sources are attached and its native frames replayed. AUTHORIZE +
      // verify thread membership BEFORE attaching any live listeners: a signal that
      // ever carried a runId from a different thread/org (a future/misrouted
      // publisher, or a bug) must never subscribe this connection to that run's
      // channels. Attaching first left a fail-closed hole - the durable `run` frame
      // was withheld but the live step/delta/native listeners stayed bound, leaking
      // frames cross-thread/cross-org (Codex review finding 1). Org-scoped read fails
      // closed; a run outside this thread is ignored without ever attaching.
      const projectRun = async (runId: string): Promise<void> => {
        const run = await getRunWithSteps(orgId, runId);
        if (!run || run.thread_id !== threadId) return;
        attachRun(runId);
        seedStepDedupe(runId, run.steps);
        sendFrame("run", { threadId, run });
        for (const frame of await getNativeFramesSince(runId, -1)) {
          if (closed) return;
          sendNative(runId, frame);
        }
      };

      void (async () => {
        // 1. Load the authoritative thread (oldest→newest), attaching every run's
        //    live sources FIRST so frames produced during replay queue up.
        const thread = await getThreadForRun(orgId, rootRunId);
        if (closed) return;
        if (!thread) return cleanup(); // resolved above; defensive
        for (const run of thread) attachRun(run.id);

        // 2. Emit the authoritative snapshot (runs carry their durable steps) BEFORE
        //    draining queued live frames, then seed step dedupe from it.
        sendFrame("snapshot", { threadId, runs: thread });
        for (const run of thread) seedStepDedupe(run.id, run.steps);

        // 3. Replay each run's durable native frames (deduped by eventId+seq).
        for (const run of thread) {
          for (const frame of await getNativeFramesSince(run.id, -1)) {
            if (closed) return;
            sendNative(run.id, frame);
          }
        }

        // 3b. Replay the thread's durable canonical events (deduped by deliverySeq).
        //     Thread-scoped + ordered; a reconnect resumes from canonicalCursor.
        for (const event of await loadCanonicalThread(threadId, 0)) {
          if (closed) return;
          sendCanonical(event);
        }

        // 3c. Replay which runs are canonicalization-COMPLETE (H2). React trusts the
        //     canonical lane for a run ONLY after this, so a reload converges on the
        //     same gate as a live client - never on the presence of provisional rows.
        for (const complete of await completeCanonicalRuns(threadId)) {
          if (closed) return;
          sendCanonicalComplete({ ...complete, threadId });
        }

        // 4. Live loop — never closes on a single run settling; only the browser
        //    disconnect (abort) or a queue overflow closes it.
        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          while (queue.length > 0 && !closed) {
            const ev = queue.shift()!;
            switch (ev.type) {
              case "signal":
                await projectRun(ev.runId);
                continue;
              case "step":
                sendStep(ev.runId, ev.step);
                continue;
              case "delta":
                sendFrame("delta", { threadId, runId: ev.runId, delta: ev.delta, kind: ev.kind });
                continue;
              case "native":
                sendNative(ev.runId, ev.frame);
                continue;
              case "canonical":
                sendCanonical(ev.event);
                continue;
              case "canonical-complete":
                sendCanonicalComplete(ev.complete);
                continue;
              case "end":
                // Settle ONE run; keep the thread connection open for queued/future
                // turns. The `settled` thread signal re-emits a `run` frame with the
                // final summary/status right after.
                sendFrame("done", { threadId, runId: ev.runId, status: ev.status });
                continue;
              default:
                assertNever(ev);
            }
          }
        }
      })().catch((err) => {
        if (!overflowed) console.error(`[thread-events] stream ${rootRunId} failed:`, err);
        cleanup();
      });
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
