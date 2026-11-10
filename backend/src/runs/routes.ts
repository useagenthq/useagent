import { Hono, type Context } from "hono";
import type { AppEnv } from "../http";
import {
  type EngineId,
  type MemoryScope,
  type RunStatus,
} from "../db/schema";
import type { RunLocation } from "@useagent/agent-client/wire";
import { PermissionModeUnsupportedError } from "../engines/permission-mode";
import { acceptedRunHandoffs, runBotMentions } from "../bots/handoffs";
import { isReservedIdempotencyKey } from "../bots/handoff-keys";
import { orgScope } from "../middleware/org";
import {
  getRun,
  getCustomerRunForOrg,
  getRunForOrg,
  getRunWithSteps,
  getStepsApi,
  getThreadForRun,
} from "./repo";
import {
  BotHomeThreadTakenError,
  acceptRunCommand,
  preflightRunCommandReplay,
  RunAdmissionClosedError,
  RunPromptTooLargeError,
  type RunCommandIntent,
} from "../commands";
import { FleetQueueLimitError } from "../fleet/intake";
import { SandboxMinutesExceededError } from "./sandbox-minutes";
import { runQueueView } from "../fleet/view";
import {
  acceptInternalRunCommand,
  ExpectedSandboxMismatchError,
  preflightInternalRunCommandReplay,
} from "../commands/service";
import { expectedSandboxRunOrigin, type InternalRunOrigin } from "./origin";
import { resolveSkillSelection } from "../skills/repo";
import { buildNativeCommandPrompt, validateCommandIntent, type CommandIntent } from "./command-intent";
import { readSessionCommandCatalog } from "./command-catalog";
import { formatRepoRef } from "../github/repo-ref";
import { createRunResourceAuthorization } from "../resources/authorization";
import {
  explicitRepositoryResources,
  decodeRunResourceSelections,
  legacyParentResources,
  resolveRunIntake,
  RunIntakeError,
  type RunResource,
} from "../resources/run-intake";
import { bus, channel, pumpThread, type BusEvent } from "../worker";
import { turnStream, type DeltaKind } from "./turn-stream";
import { assertNever } from "../util/exhaustive";
import { sseResponse } from "../util/sse";
import { getNativeFramesSince, subscribeNative, type NativeFrame } from "./native-events";
import { parseResumeCursor, resolveNativeResume, resolveResumeCursor, resumeFramePayload } from "./thread-resume";
import {
  admitCanonicalComplete,
  loadCanonicalThread,
  subscribeCanonicalThread,
  subscribeCanonicalizationComplete,
  type CanonicalizationComplete,
  type DeliveredCanonicalEvent,
} from "./canonical-events";
import { completeCanonicalRuns } from "./canonicalization-outbox";
import { subscribeThread } from "./thread-signals";
import { registerRunChangesRoute } from "./changes-route";
import type { ApiStep } from "./repo";
import { defaultModelForEngine, isReplyModelAllowedForEngine, replyModelAdmittedForUser } from "./model-policy";
import {
  engineResolutionErrorBody,
  modelProviderReadinessErrorBody,
  modelProviderReadyForEngine,
} from "./engine-readiness";
import { resolveEngineForUser, sandboxLoginOffered } from "../engines/sandbox-login";
import { registerRunCancelRoute } from "./cancel-route";
import { registerSandboxReleaseRoute } from "./sandbox-release";
import { parseProviderSessionBinding } from "@useagent/agent-harness/canonical";
import { UploadClaimError } from "../uploads/repo";
import { registerRunReadRoutes } from "./read-routes.js";
import { registerExecutionGraphRoutes } from "./execution-graph-routes.js";
import { registerProviderSessionRoutes } from "./provider-session-routes.js";
import { enqueueSlackUserMirrorForRun } from "../slack/user-mirror";
import { kickSlackOutbox } from "../slack/outbox";
import { boundedRunPrompt, runAttachmentIds, runCreateBodyLimit, runMemoryScope, runModelAndEngine, runPermissionMode, type RunCreateBody } from "./run-create-policy";
import { reasoningEffortSupportForRun, resolveReasoningEffort } from "./reasoning-effort";
import { acceptExistingThreadFollowup, ThreadFollowupTargetError } from "./thread-followups";
import { machineUnavailable, runLocationChoice } from "./run-location";
import { SpendAllowanceExceededError } from "./spend";
export type { RunCreateBody } from "./run-create-policy";
export const runsRoutes = new Hono<AppEnv>();
runsRoutes.use("*", orgScope);
export async function handleRunCreate(
  c: Context<AppEnv>,
  options: {
    readonly body?: RunCreateBody;
    readonly origin?: InternalRunOrigin;
    readonly expectedSandbox?: RunCommandIntent["expectedSandbox"]; // Trusted operator only, never the public body.
    /** The bot whose home thread this root run opens (stamped with the run, see
     *  RunCommandInput.botHome); a lost race answers 409 with no run created. */
    readonly botHome?: { readonly botId: string };
  } = {},
): Promise<Response> {
  let body: RunCreateBody;
  if (options.body) {
    body = options.body;
  } else {
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
  }
  if (body.origin !== undefined) {
    return c.json({ error: "origin is server-owned" }, 400);
  }

  const promptResult = boundedRunPrompt(body.prompt);
  if (!promptResult.ok) return c.json({ error: promptResult.error }, promptResult.status);
  const prompt = promptResult.prompt;

  const attachments = runAttachmentIds(body.attachments, Boolean(c.get("userId")));
  if (!attachments.ok) return c.json({ error: attachments.error }, attachments.status);
  const attachmentIds = attachments.ids;

  const botMentions = runBotMentions(c.get("orgId"), body.bot_mentions);
  if ("status" in botMentions) return c.json(botMentions.body, botMentions.status);
  const requestedResources = decodeRunResourceSelections(body.resources ?? []);
  if (!requestedResources) return c.json({ error: "resources must be an array of valid resource selections" }, 400);

  const selection = runModelAndEngine(body);
  if (!selection.ok) return c.json({ error: selection.error }, 400);
  const { model: requestedModel, engine: requestedEngine } = selection;

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
  let parentReasoningEffort: string | null = null;
  let parentEngine: EngineId | null = null;
  let parentOrigin: string | null = null;
  let parentRunLocation: RunLocation | null = null;
  // The ACTIVE native session this turn resumes, derived SERVER-SIDE from the parent run (a
  // reply resumes the thread's live session). A native-command intent's client-supplied session
  // id is validated against THIS, never trusted on its own.
  let activeSessionId: string | null = null;
  if (body.parent_run_id !== undefined && body.parent_run_id !== null) {
    const rawParent =
      typeof body.parent_run_id === "string" ? body.parent_run_id.trim() : "";
    if (!rawParent) return c.json({ error: "parent_run_id must be a run id string" }, 400);
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
    parentReasoningEffort = parent.reasoningEffort;
    parentEngine = parent.engine;
    parentOrigin = parent.origin;
    parentRunLocation = parent.runLocation;
    activeSessionId = parseProviderSessionBinding(parent.providerSession)?.nativeSessionId ??
      parent.engineSessionId ?? null;
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
  // otherwise a reply INHERITS its parent's and a root run defaults to "org".
  // Permission mode: only an explicit choice is taken here; an omitted mode is
  // resolved at the insert, under the thread lock, so an older parent or a read
  // made before a narrowing reply cannot widen the thread.
  const scope = runMemoryScope(body.memory_scope, parentScope);
  if (!scope.ok) return c.json({ error: scope.error }, 400);
  const { memoryScope, requestedMemoryScope } = scope;
  const permission = runPermissionMode(body.permission_mode);
  if (!permission.ok) return c.json({ error: permission.error }, 400);
  const { permissionMode } = permission;
  // Run location: a root run's cloud-or-machine choice (the machine's availability is asked below, of a new acceptance only); a reply inherits.
  const location = runLocationChoice(body.run_location, parentRunId !== null);
  if (!location.ok) return c.json(location.body, location.status);

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
    if (!rawId) return c.json({ error: "skill.id must be a skill id string" }, 400);
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
  if (requestedCommand && (requestedResources.length > 0 || attachmentIds.length > 0)) {
    return c.json(
      { error: "invalid_command", reason: "native commands cannot add run resources" },
      400,
    );
  }

  const idempotencyKey = c.req.header("Idempotency-Key")?.trim() || null;
  if (!options.origin && idempotencyKey && isReservedIdempotencyKey(idempotencyKey)) {
    return c.json({ error: "reserved_idempotency_key" }, 400);
  }
  const intent: RunCommandIntent = {
    prompt: finalPrompt,
    model: requestedModel,
    reasoningEffort: body.reasoning_effort == null ? null : String(body.reasoning_effort),
    engine: requestedEngine,
    parentRunId,
    requestedRepos,
    requestedResources,
    attachmentIds,
    memoryScope: requestedMemoryScope,
    permissionMode: permissionMode ?? null, runLocation: location.runLocation ?? null,
    skillId: requestedSkillId,
    skillVersion: requestedSkillVersion,
    commandName: requestedCommand?.name.trim() || null,
    commandProvider: requestedCommand?.provider ?? null,
    commandSessionId: requestedCommand?.sessionId ?? null,
    commandCatalogRevision: requestedCommand?.catalogRevision ?? null,
    expectedSandbox: options.expectedSandbox ?? null,
  };
  let replay;
  try {
    const replayOrigin = options.expectedSandbox
      ? expectedSandboxRunOrigin(parentOrigin)
      : options.origin;
    if (options.expectedSandbox && !replayOrigin) throw new ExpectedSandboxMismatchError();
    replay = replayOrigin
      ? await preflightInternalRunCommandReplay({
          orgId: c.get("orgId"),
          idempotencyKey,
          intent,
          origin: replayOrigin,
        })
      : await preflightRunCommandReplay({
          orgId: c.get("orgId"),
          idempotencyKey,
          intent,
        });
  } catch (error) {
    if (error instanceof RunAdmissionClosedError) {
      return c.json(error.body, 503);
    }
    if (error instanceof ExpectedSandboxMismatchError) return c.json({ error: error.code }, 409);
    throw error;
  }
  if (replay?.status === "replayed") {
    const mirror = await enqueueSlackUserMirrorForRun(replay.runId);
    if (mirror.status === "ready" && mirror.created) kickSlackOutbox();
    return c.json({ id: replay.runId }, 200);
  }
  if (replay?.status === "conflict") {
    return c.json({ error: "idempotency_key_reused", reason: replay.reason }, 409);
  }
  // Mutable authorization/readiness checks apply only to first acceptance.
  const machine = location.runLocation === "local" ? await machineUnavailable({ orgId: c.get("orgId"), userId: c.get("userId") }) : null;
  if (machine) return c.json(machine.body, machine.status);
  if (parentEngine && requestedEngine && requestedEngine !== parentEngine) return c.json({ error: "reply_engine_mismatch", engine: parentEngine }, 400);
  const runLocation = location.runLocation ?? parentRunLocation;
  const resolvedEngine = await resolveEngineForUser({ orgId: c.get("orgId"), userId: c.get("userId"), runLocation }, parentEngine ?? requestedEngine);
  if (!resolvedEngine.ok) return c.json(engineResolutionErrorBody(resolvedEngine), resolvedEngine.status);
  const engine = resolvedEngine.engine;
  const inheritedModel =
    parentModel && isReplyModelAllowedForEngine(engine, parentModel, parentModel)
      ? parentModel
      : defaultModelForEngine(engine);
  const model = requestedModel ?? inheritedModel;
  if (!(await replyModelAdmittedForUser(engine, model, parentModel, c.get("userId")))) {
    return c.json({ error: "model_not_allowed", engine, model }, 400);
  }
  const actor = c.get("userId") ? { orgId: c.get("orgId"), userId: c.get("userId") as string } : null;
  const effort = resolveReasoningEffort(body.reasoning_effort, await reasoningEffortSupportForRun(engine, model, actor), parentReasoningEffort);
  if (!effort.ok) return c.json({ error: effort.error, engine, efforts: effort.efforts }, 400);
  if (!modelProviderReadyForEngine(engine, model) && !(await sandboxLoginOffered({ orgId: c.get("orgId"), userId: c.get("userId"), runLocation }, engine))) {
    return c.json(modelProviderReadinessErrorBody(engine, model), 403);
  }

  if (requestedSkillId) {
    const pinned = await resolveSkillSelection(c.get("orgId"), {
      id: requestedSkillId,
      version: requestedSkillVersion ?? undefined,
    });
    if (!pinned) return c.json({ error: "skill not found in this org (or unknown version)" }, 400);
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
        explicitResources: [
          ...(parentRunId ? [] : explicitRepositoryResources(repos)),
          ...requestedResources,
        ],
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
  let accepted;
  try {
    const commandInput = {
      idempotencyKey,
      orgId: c.get("orgId"),
      actorId: c.get("userId"),
      intent,
      expectedSandbox: options.expectedSandbox ?? null,
      run: { id, prompt: finalPrompt, model, reasoningEffort: effort.value, engine, parentRunId, threadId, repos, resolvedResources, attachmentIds, memoryScope, permissionMode, runLocation: location.runLocation, skillId, skillVersion, skillContentHash, commandName, commandProvider, commandSessionId, commandCatalogRevision },
      ...(options.botHome && !parentRunId ? { botHome: options.botHome } : {}),
    };
    accepted = parentRunId
      ? await acceptExistingThreadFollowup(c.get("orgId"), parentRunId, commandInput)
      : options.origin
        ? await acceptInternalRunCommand({ ...commandInput, origin: options.origin })
        : await acceptRunCommand(commandInput);
  } catch (error) {
    if (error instanceof RunPromptTooLargeError) {
      return c.json({ error: error.code }, 413);
    }
    if (error instanceof PermissionModeUnsupportedError) return c.json({ error: error.code, engine: error.engine }, 400);
    if (error instanceof UploadClaimError) return c.json({ error: "upload_unavailable" }, 409);
    if (error instanceof ThreadFollowupTargetError) return c.json({ error: error.code }, error.status);
    if (error instanceof ExpectedSandboxMismatchError) return c.json({ error: error.code }, 409);
    if (error instanceof BotHomeThreadTakenError) {
      return c.json(
        { error: error.code, reason: "Another message opened this bot's thread first. Send yours again into that thread." },
        409,
      );
    }
    if (error instanceof RunAdmissionClosedError) return c.json(error.body, 503);
    if (error instanceof SpendAllowanceExceededError || error instanceof SandboxMinutesExceededError) return c.json(error.body, 402);
    // Durable per-org queue ceiling exceeded — the server-side fan-out authority.
    if (error instanceof FleetQueueLimitError)
      return c.json({ error: error.code, retryable: true, limit: error.limit }, 429);
    throw error;
  }

  // Translate acceptance exhaustively; new outcome variants must be handled.
  switch (accepted.status) {
    case "created": {
      // Mirror accepted context before dispatch; busy threads remain durably queued.
      const mirror = await enqueueSlackUserMirrorForRun(accepted.runId);
      if (mirror.status === "ready" && mirror.created) kickSlackOutbox();
      await pumpThread(threadId);
      const handoffs = await acceptedRunHandoffs({ orgId: c.get("orgId"), actorId: c.get("userId"), runId: accepted.runId, threadId, text: prompt, botIds: botMentions.ids });
      const queue = await runQueueView(accepted.runId);
      const status = queue?.state === "queued" ? "queued" : "running";
      return c.json({ id: accepted.runId, status, queue, ...handoffs }, 201);
    }
    case "replayed":
      // Return the existing run without redispatching it.
      return c.json({ id: accepted.runId }, 200);
    case "conflict":
      return c.json(
        { error: "idempotency_key_reused", reason: accepted.reason },
        409,
      );
    default:
      return assertNever(accepted);
  }
}

runsRoutes.post("/", runCreateBodyLimit, (c) => handleRunCreate(c));

registerRunCancelRoute(runsRoutes);
registerSandboxReleaseRoute(runsRoutes);
registerRunChangesRoute(runsRoutes);
registerRunReadRoutes(runsRoutes);
registerExecutionGraphRoutes(runsRoutes);
registerProviderSessionRoutes(runsRoutes);

// SSE trace stream: replay existing steps, then live-push new ones.
//
// Served through `sseResponse` (util/sse.ts): anti-buffering headers, opening
// comment, heartbeat, and teardown when the client aborts, cancels the body or
// a write fails. Speed comes from delta publishing + immediate enqueue.
runsRoutes.get("/:id/events", async (c) => {
  const id = c.req.param("id");
  // Authorize by org first — a cross-org (or missing) id is a 404, never a stream.
  if (!(await getCustomerRunForOrg(c.get("orgId"), id))) {
    return c.json({ error: "run not found" }, 404);
  }

  // A live assistant-text delta AND a versioned native frame are multiplexed
  // onto the SAME queue as bus events, so ALL frames are written by the single
  // drain loop below in order.
  type OutEvent =
    | BusEvent
    | { type: "delta"; delta: string; kind?: DeltaKind }
    | { type: "native"; frame: NativeFrame };

  // Native-frame lane cursor: replay lossless native events with seq strictly
  // greater than `?cursor=` (default -1 → from the start; seq begins at 0). A
  // malformed cursor is ignored (treated as absent) rather than erroring.
  const cursorRaw = c.req.query("cursor");
  const cursorSeq = cursorRaw !== undefined && Number.isFinite(Number(cursorRaw))
    ? Number(cursorRaw)
    : -1;

  return sseResponse({ signal: c.req.raw.signal }, (stream) => {
    // idx → content fingerprint of the LAST version sent. Updates (same idx,
    // enriched code_json) must pass; only true duplicates are suppressed.
    const emitted = new Map<number, string>();
    // Native-frame dedupe: eventId → the highest seq already sent. A revision
    // (same eventId, higher seq) passes; a replay/live overlap is suppressed.
    const nativeSeen = new Map<string, number>();
    const queue: OutEvent[] = [];
    let wake: (() => void) | null = null;

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
      stream.sendEvent("native", frame);
    };

    // Drive replay + the live loop OUTSIDE start() so the response streams
    // immediately (start resolving isn't gated on the whole run finishing).
    void (async () => {
      // Replay everything already persisted (subscribed first, so no gap).
      for (const step of await getStepsApi(id)) {
        if (stream.closed) return;
        emitted.set(step.idx, `${step.id}|${step.code_json ?? ""}`);
        stream.sendEvent("step", step);
      }

      // Replay the native lane from the client's cursor (ordered by seq;
      // already deduped by native id in the store). Subscribed before this, so
      // a frame persisted during replay arrives on the live queue and the
      // seq-dedupe suppresses the overlap.
      for (const frame of await getNativeFramesSince(id, cursorSeq)) {
        if (stream.closed) return;
        sendNative(frame);
      }

      // If the run already finished, close immediately after replay.
      const snapshot = await getRun(id);
      if (snapshot && (snapshot.status === "completed" || snapshot.status === "failed")) {
        stream.sendEvent("done", { id, status: snapshot.status });
        return stream.close();
      }

      // Live loop.
      while (!stream.closed) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        while (queue.length > 0 && !stream.closed) {
          const ev = queue.shift()!;
          switch (ev.type) {
            case "step": {
              // Same idx may arrive again with enriched code_json (tool output
              // attached in place) — forward it; skip only true duplicates.
              const fp = `${ev.step.id}|${ev.step.code_json ?? ""}`;
              if (emitted.get(ev.step.idx) === fp) continue;
              emitted.set(ev.step.idx, fp);
              stream.sendEvent("step", ev.step);
              continue;
            }
            case "delta":
              stream.sendEvent("delta", { delta: ev.delta, kind: ev.kind });
              continue;
            case "native":
              sendNative(ev.frame);
              continue;
            case "end":
              stream.sendEvent("done", { id, status: ev.status });
              return stream.close();
            default:
              assertNever(ev);
          }
        }
      }
    })();

    return () => {
      bus.off(channel(id), push);
      unsubscribeDeltas();
      unsubscribeNative();
      wakeUp();
    };
  });
});

// ADDITIVE thread SSE stream (final_fix.md): ONE realtime subscription for a whole
// useAgent conversation, keyed by the ROOT run id in the URL — not whichever run
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
// Reconnect replays the snapshot plus, per thread-resume.ts, the native frames and canonical
// rows the browser's cursors do not cover. The old per-run `/:id/events` route is untouched.
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
  const rootRun = await getCustomerRunForOrg(orgId, rootRunId);
  if (!rootRun) return c.json({ error: "run not found" }, 404);
  const threadId = rootRun.threadId;
  const requested = parseResumeCursor(c.req.query("canonicalAfter"), c.req.query("canonicalId"), c.req.query("epoch"), c.req.queries("nativeAfter"));

  type ThreadOut =
    | { type: "signal"; runId: string }
    | { type: "step"; runId: string; step: ApiStep }
    | { type: "end"; runId: string; status: RunStatus }
    | { type: "delta"; runId: string; delta: string; kind?: DeltaKind }
    | { type: "native"; runId: string; frame: NativeFrame }
    | { type: "canonical"; event: DeliveredCanonicalEvent }
    | { type: "canonical-complete"; complete: CanonicalizationComplete };

  return sseResponse({ signal: c.req.raw.signal }, (stream) => {
    const queue: ThreadOut[] = [];
    let wake: (() => void) | null = null;
    let overflowed = false;

    // Per-run dedupe state (keyed by runId): step idx→content fingerprint, and
    // native eventId→highest seq. Mirrors the per-run route's dedupe, one map
    // per run so replay/live overlap collapses without cross-run interference.
    const emittedByRun = new Map<string, Map<number, string>>();
    const nativeSeenByRun = new Map<string, Map<string, number>>();
    // Per-run live-source listeners, torn down together on disconnect.
    const attached = new Set<string>();
    const perRunCleanups = new Map<string, () => void>();

    const wakeUp = (): void => {
      if (wake) {
        wake();
        wake = null;
      }
    };
    const push = (ev: ThreadOut): void => {
      if (stream.closed) return;
      if (queue.length >= MAX_QUEUE) {
        // Bound memory: drop the connection so the browser reconnects to a fresh
        // authoritative snapshot instead of buffering without limit.
        overflowed = true;
        stream.close();
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
      stream.sendEvent("step", { threadId, runId, step });
    };
    const seedStepDedupe = (runId: string, steps: readonly ApiStep[]): void => {
      let m = emittedByRun.get(runId);
      if (!m) {
        m = new Map();
        emittedByRun.set(runId, m);
      }
      for (const s of steps) m.set(s.idx, `${s.id}|${s.code_json ?? ""}`);
    };

    const nativeSeen = (runId: string): Map<string, number> =>
      nativeSeenByRun.get(runId) ?? nativeSeenByRun.set(runId, new Map()).get(runId)!;
    // Emit a native frame if it advances its eventId's seq (dedupe replay/live).
    const sendNative = (runId: string, frame: NativeFrame): void => {
      const m = nativeSeen(runId);
      if ((m.get(frame.eventId) ?? -1) >= frame.seq) return;
      m.set(frame.eventId, frame.seq);
      stream.sendEvent("native", { threadId, runId, frame });
    };

    // Canonical lane: the provider-neutral events, deduped
    // by the IMMUTABLE thread delivery cursor - replay + live never re-send a cursor.
    // Thread-scoped (threadId was authorized at route entry), so no per-run attach.
    let canonicalCursor = 0;
    const sendCanonical = (event: DeliveredCanonicalEvent): void => {
      if (event.deliverySeq <= canonicalCursor) return;
      canonicalCursor = event.deliverySeq;
      stream.sendEvent("canonical", { threadId, event });
    };
    // Canonicalization-complete (H2): the per-run signal that its canonical projection
    // is trustworthy. Deduped per run so replay + live never re-announce a run.
    const canonicalCompleteSeen = new Map<string, boolean>(); // runId -> degraded (see admitCanonicalComplete)
    const sendCanonicalComplete = (complete: CanonicalizationComplete): void => {
      if (!admitCanonicalComplete(canonicalCompleteSeen, complete)) return;
      stream.sendEvent("canonical-complete", { threadId, complete });
    };

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
      stream.sendEvent("run", { threadId, run });
      for (const frame of await getNativeFramesSince(runId, -1)) {
        if (stream.closed) return;
        sendNative(runId, frame);
      }
    };

    void (async () => {
      // 1. Load the authoritative thread (oldest→newest), attaching every run's live
      //    sources FIRST so frames produced during replay queue up.
      const thread = await getThreadForRun(orgId, rootRunId);
      if (stream.closed) return;
      if (!thread) return stream.close(); // resolved above; defensive
      for (const run of thread) attachRun(run.id);

      // 2. Say whether the browser's canonical resume cursor is honoured (a refused one
      //    replays from zero, and the browser drops what it retained), then the snapshot.
      const resume = await resolveResumeCursor(threadId, requested);
      canonicalCursor = resume.canonicalAfter;
      stream.sendEvent("resume", resumeFramePayload(threadId, resume));
      stream.sendEvent("snapshot", { threadId, runs: thread });
      for (const run of thread) seedStepDedupe(run.id, run.steps);

      // 3. Runs whose canonicalization is COMPLETE (H2), read BEFORE the canonical rows so a
      //    run finalized between the reads announces completion via the live loop. A sealed
      //    run the browser proved it holds (thread-resume.ts) counts as sent up to its cursor
      //    and replays only what is above it; every other run replays every frame.
      const completes = await completeCanonicalRuns(threadId);
      const native = await resolveNativeResume(requested.native, new Map(completes.map((c) => [c.runId, c.sourceFrameMax])), { epoch: requested.epoch, reset: resume.reset });
      for (const run of thread) {
        for (const held of native.retained(run.id)) nativeSeen(run.id).set(held.eventId, held.seq);
        for (const frame of await native.replay(run.id)) {
          if (stream.closed) return;
          sendNative(run.id, frame);
        }
      }

      // 3b. Canonical rows above the cursor (deduped by deliverySeq), then the completions.
      for (const event of await loadCanonicalThread(threadId, resume.canonicalAfter)) {
        if (stream.closed) return;
        sendCanonical(event);
      }
      for (const complete of completes) {
        if (stream.closed) return;
        sendCanonicalComplete({ ...complete, threadId });
      }

      // 4. Live loop — never closes on a single run settling; only the browser
      //    disconnect (abort) or a queue overflow closes it.
      while (!stream.closed) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        while (queue.length > 0 && !stream.closed) {
          const ev = queue.shift()!;
          switch (ev.type) {
            case "signal":
              await projectRun(ev.runId);
              continue;
            case "step":
              sendStep(ev.runId, ev.step);
              continue;
            case "delta":
              stream.sendEvent("delta", { threadId, runId: ev.runId, delta: ev.delta, kind: ev.kind });
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
              stream.sendEvent("done", { threadId, runId: ev.runId, status: ev.status });
              continue;
            default:
              assertNever(ev);
          }
        }
      }
    })().catch((err) => {
      if (!overflowed) console.error(`[thread-events] stream ${rootRunId} failed:`, err);
      stream.close();
    });

    return () => {
      unsubscribeThread();
      unsubscribeCanonical();
      unsubscribeCanonicalComplete();
      for (const off of perRunCleanups.values()) off();
      perRunCleanups.clear();
      attached.clear();
      wakeUp();
    };
  });
});
