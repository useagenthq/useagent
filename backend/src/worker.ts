import { join } from "node:path";
import {
  buildThreadPreamble,
  getRun,
  getThreadProviderSessionState,
  insertStep,
  setRunStatus,
  updateStepCode,
} from "./runs/repo";
import type { ProviderSessionBinding } from "@useagent/agent-harness/canonical";
import type { EngineId } from "./db/schema";
import { resolveProviderRegistration, runProviderTurn } from "./engines";
import { persistedEngineModelReadyForDispatch } from "./runs/engine-readiness";
import type { EmitStep, EngineRunContext, RunInputFile } from "./engines/types";
import { classifyTurnFailure } from "./engines/turn-failure-classification";
import { recallScopedMemory } from "./memory/team-memory";
import { resolveScopedMemory } from "./memory/scope";
import { isInternalRunOrigin } from "./runs/origin";
import { recordContextRetrieval } from "./memory/retrieval-ledger";
import { listSkillCatalogForOrg } from "./skills/repo";
import { resolveExecutableSkillPin } from "./skills/pins";
import {
  formatSkillCatalogPrefill,
  frameSkillCatalogContext,
  shouldPrefillSkillCatalog,
} from "./skills/catalog";
import { formatSkillMarkdown, frameSkillContext } from "./skills/format";
import { recordSkillLoaded } from "./skills/skill-loaded";
import {
  finalizeRun,
  resolveDurableFinalizationOutcome,
  type FinalizeRunResult,
} from "./runs/finalize";
import { turnStream } from "./runs/turn-stream";
import { publishRunLifecycleChange } from "./runs/org-signals";
import { settleCommandForRun } from "./commands/dispatch";
import { releaseOnSettle } from "./fleet/admission";
import { pumpThreadWithGate } from "./fleet/pump";
import {
  createFirstOutputMarker,
  createRunTimer,
  RUN_TIMING_OUTCOMES,
  RUN_TIMING_STAGES,
  type RunStageTimer,
} from "./runs/run-timing";
import { listRunUploads } from "./uploads/repo";
import { formatInputContext, sandboxInputPath } from "./uploads/materialize";
import { CHAT_SYSTEM_PROMPT } from "./chat/prompt";
import { retrieveChatContext } from "./chat/retrieve";
import { streamChat, type ChatMessage } from "./chat/stream";
import { resolveChatProviderCredential } from "./provider-gateway/credentials";
import { subscribeNative } from "./runs/native-events";
import { createSlidingInactivityWatchdog } from "./runs/inactivity-watchdog";
import {
  buildResourceAccessSnapshot,
  formatResourceAccessContext,
} from "./resources/access-snapshot";
import { runMock } from "./worker-mock.js";
import { bus, channel, RUN_SPAWNED, type BusEvent } from "./worker-events.js";
import { strictOrgSecretRedactor } from "./secrets/store";
import { errorMessage } from "./util/error-message";
import { ensureRunWorkdir } from "./run-workdir";
import { createProviderSessionSaver } from "./worker-provider-session";

export { bus, channel, RUN_SPAWNED, type BusEvent } from "./worker-events.js";
export { ensureRunWorkdir } from "./run-workdir";

async function emitFinalizedEnd(runId: string, finalized: FinalizeRunResult): Promise<void> {
  const durable = await resolveDurableFinalizationOutcome(runId, finalized);
  if (finalized.applied && durable) {
    bus.emit(channel(runId), { type: "end", status: durable.status } satisfies BusEvent);
  }
}

// ---------------------------------------------------------------------------
// Actor-lite registry: one logical worker per run id.
//
// This is a STUB. The scripted trace below stands in for the real Claude Agent
// SDK loop (migration step 2). It exists to prove the durable event log + SSE
// streaming path end-to-end — now writing into Postgres via Drizzle.
// ---------------------------------------------------------------------------

const registry = new Map<string, Promise<void>>();

/** Run ids with a live actor in THIS process — the Stage-A lease-liveness signal
 *  the fleet reconciler heartbeats (process-local by design; see the fleet
 *  architecture note). */
export const liveActorRunIds = (): string[] => [...registry.keys()];

// runId → abort the in-flight actor with a reason. Present ONLY while an actor
// executes in THIS process. A durable `run.cancel` command records the intent
// (commands/cancel.ts); this is the in-memory signal that stops the live turn
// fast. Cleared in runWorker's finally.
const cancellers = new Map<string, (reason: string) => void>();

/** Signal the in-flight actor for `runId` to stop with `reason` (a user cancel).
 *  Returns true if a live actor was signalled, false if none runs in this
 *  process (queued/terminal/gone). Idempotent — the first reason wins. */
export function signalCancel(runId: string, reason: string): boolean {
  const cancel = cancellers.get(runId);
  if (!cancel) return false;
  cancel(reason);
  return true;
}

/** Resolve the terminal status/summary when an engine adapter RETURNS normally
 *  (Blocker 2). A durably-accepted user cancellation dominates a coincident provider
 *  completion: `cancelledReason` (non-null, e.g. "Stopped by user") wins as a FAILED
 *  terminal; otherwise the provider's completion stands. Pure + deterministic. */
export function terminalOnReturn(
  cancelledReason: string | null,
  summary: string | null,
): { status: "completed" | "failed"; summary: string } {
  return cancelledReason !== null
    ? { status: "failed", summary: cancelledReason }
    : { status: "completed", summary: summary ?? "run completed" };
}

/** Spawn (or no-op if already running) the actor for a run. Dispatches on the
 *  run's `engine`: `mock` → the scripted trace below (unchanged default), any
 *  other → its real pluggable adapter (src/engines/*). */
export function spawnWorker(runId: string): void {
  if (registry.has(runId)) return;
  // Announce BEFORE the actor runs so a connector feed subscribes to the run's
  // bus channel ahead of the first step. Listener errors must never break run
  // creation, so this is isolated from the spawn path.
  try {
    bus.emit(RUN_SPAWNED, runId);
  } catch (err) {
    console.error(`[worker] RUN_SPAWNED listener threw for run ${runId}:`, err);
  }
  const task = runWorker(runId).finally(() => registry.delete(runId));
  registry.set(runId, task);
}

// A conversation is SEQUENTIAL: one live engine turn per thread. Turn ordering
// is now DURABLE — enforced by the commands mailbox (src/commands/dispatch.ts),
// not an in-memory chain. spawnWorker is only ever called for a command the
// mailbox has already CLAIMED (state → dispatched), so at most one run per
// thread executes at a time, and a queued reply survives a crash. When a run
// settles, `onRunSettled` frees the thread and pumps the next queued command.

/** Claim + capacity-gate + spawn the thread's next turn (see fleet/pump). Null if
 *  the thread is busy/empty OR capacity is not yet available (stays queued). */
export const pumpThread = (threadId: string): Promise<string | null> =>
  pumpThreadWithGate(threadId, spawnWorker);

/** Settle the run's command, release its capacity lease (so the reconciler can
 *  admit queued work), and pump the thread's next turn. Every terminal path. */
async function onRunSettled(runId: string, threadId: string): Promise<void> {
  await settleCommandForRun(runId).catch((err) =>
    console.error(`[worker] settle command for run ${runId} failed:`, err),
  );
  await releaseOnSettle(runId).catch((err) => console.error(`[worker] release lease ${runId}:`, err));
  await pumpThread(threadId).catch((err) =>
    console.error(`[worker] pump thread ${threadId} failed:`, err),
  );
}

/** Start a real engine turn at the trusted worker boundary, before any optional
 * context or runtime preparation can add seconds of silent UI time. The row is
 * durable (so reload/reconnect sees the same state) and also published live.
 * Returns the next step index for the engine adapter. */
export async function beginEngineRun(
  runId: string,
  threadId: string,
  orgId: string | null,
  origin: string | null = null,
): Promise<number> {
  await setRunStatus(runId, "running");
  if (!isInternalRunOrigin(origin)) {
    publishRunLifecycleChange({ orgId, threadId, runId, kind: "running" });
  }
  const step = await insertStep({
    runId,
    idx: 0,
    kind: "task",
    label: "Preparing context and runtime…",
    chip: "boot",
    code: { phase: "preparing" },
  });
  bus.emit(channel(runId), { type: "step", step } satisfies BusEvent);
  return 1;
}

async function runWorker(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) return; // deleted before the actor started

  // Cancellation plumbing (durable cancel): ONE AbortController per actor,
  // registered so an out-of-band `run.cancel` can abort THIS live turn. The
  // engine timeout aborts the same signal; `cancelReason` (set only on a user
  // cancel) is how the finalize path tells the two apart.
  const ac = new AbortController();
  let cancelReason: string | null = null;
  const requestCancel = (reason: string): void => {
    if (cancelReason === null) cancelReason = reason;
    ac.abort();
  };
  const wasCancelled = (): string | null => cancelReason;
  cancellers.set(runId, requestCancel);

  // Perf Phase 0: per-run stage ledger (real engines only; mock keeps its exact
  // scripted fixture). Fire-and-forget diagnostics - never on the critical path.
  const stageLedger: RunStageTimer | null =
    run.engine === "mock" ? null : createRunTimer(runId, run.threadId);

  try {
    // Match mature agent UIs: expose a truthful, durable lifecycle row
    // immediately, then do memory/skill/runtime work behind it. Mock retains its
    // exact scripted fixture; every real engine starts its own rows at index 1.
    const endAccept = stageLedger?.begin("worker.accept_to_running");
    const firstEngineStep =
      run.engine === "mock" || run.engine === "chat"
        ? 0
        : await beginEngineRun(run.id, run.threadId, run.orgId, run.origin);
    endAccept?.();

    // Skill context (Phase 0 slice 0.1): resolve + record the run's pinned skill
    // FIRST, for ANY engine. A run that selected a skill "loaded" it regardless of
    // harness — mock ignores context, but the durable `skill.loaded` marker and
    // provenance still hold. `skillContext` is the SKILL.md-shaped INSTRUCTIONS,
    // injected below via the per-turn seam SEPARATELY from the (clean) user prompt.
    const endSkillLookup = stageLedger?.begin("worker.skill_lookup");
    const pinnedSkill = await (async () => {
      try {
        return resolveExecutableSkillPin({
          skillId: run.skillId,
          skillVersion: run.skillVersion,
          skillContentHash: run.skillContentHash,
        });
      } finally {
        endSkillLookup?.();
      }
    })();
    let skillContext = "";
    if (pinnedSkill) {
      const markdown = formatSkillMarkdown(pinnedSkill.content);
      skillContext = frameSkillContext(markdown);
      // Emit skill.loaded (metadata only, no body) on the durable native lane so
      // it renders as a timeline row and survives reconnect. AWAITED here (before
      // the engine runs, well off the delta fast-path) so a crash can't lose the
      // evidence that a skill governed this run; a persist failure is logged and
      // never fails the run.
      const endSkillMarker = stageLedger?.begin("worker.skill_marker");
      try {
        await recordSkillLoaded(run.id, run.threadId, {
          skillId: pinnedSkill.skillId,
          version: pinnedSkill.version,
          kind: pinnedSkill.kind,
          name: pinnedSkill.content.name,
          contentHash: pinnedSkill.contentHash,
          source: "skill",
          contentChars: markdown.length,
        }).catch((err) =>
          console.warn(`[worker] skill.loaded marker persist failed for run ${run.id}:`, err),
        );
      } finally {
        endSkillMarker?.();
      }
    }

    // `mock` is the scripted trace and ignores context entirely. It IS
    // cancellable — the abortable sleep + signal make a live mock turn stop.
    if (run.engine === "mock") {
      await runMock(runId, run.threadId, run.orgId, run.origin, ac.signal, wasCancelled);
      return;
    }
    if (run.engine === "chat") {
      await runChat(run, skillContext, ac.signal, wasCancelled);
      return;
    }

    // Split the run's context (north star "Fix the Current Context Bug First"):
    //  - turnContext: fresh TEAM MEMORY (config-gated; "" when MEMORY_API_URL is
    //    unset), already reference-framed. Injected on EVERY turn (fresh AND
    //    resumed) so a continuing conversation still sees newly recalled memory.
    //  - bootstrapContext: the reconstructed prior thread, injected ONLY into a
    //    FRESH native session (a resumed session already holds it natively).
    // Fetched in PARALLEL — independent context work must not serialize startup.
    // Prompts are stored clean; the composed prefix is the engine's only view.
    //
    // The scope PLAN maps the run's persisted identity + memoryScope to the pools
    // it reads (org → org pool; personal → personal + org) and the single pool it
    // captures into; null when memory is disabled. Identity is ALWAYS from the run
    // row — never the sandbox/prompt.
    const plan = resolveScopedMemory(run);
    // Start the native-session lookup alongside every other independent context
    // source. The result both controls fresh-only catalog prefill and is reused
    // by the adapter, avoiding a second DB lookup before dispatch.
    const providerSessionStatePromise = getThreadProviderSessionState(
      run.threadId,
      run.engine,
      run.id,
    );
    const endContext = stageLedger?.begin("worker.context");
    const timedContextOperation = async <T>(
      stage: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      const end = stageLedger?.begin(stage);
      try {
        return await operation();
      } finally {
        end?.();
      }
    };
    const [providerSessionState, recall, bootstrapContext, skillCatalogPage, resourceSnapshot] = await Promise.all([
      providerSessionStatePromise,
      // Layered recall (new_mem_prompt.md 6.2): Tencent L0 (immediate ground
      // evidence, incl. explicit "remember X") + L1 (distilled) searched in
      // parallel and merged, so a freshly-taught fact is injected into a NEW
      // thread's context before L1 extraction even finishes.
      timedContextOperation("worker.memory_recall", () =>
        plan ? recallScopedMemory(run.prompt, plan.readPools) : Promise.resolve(null),
      ),
      timedContextOperation("worker.thread_preamble", () =>
        run.parentRunId ? buildThreadPreamble(run.threadId, run.id) : Promise.resolve(""),
      ),
      timedContextOperation("worker.skill_catalog", async () => {
        const state = await providerSessionStatePromise;
        const engineSessionId = state.binding?.nativeSessionId ?? state.legacySessionId ?? undefined;
        if (
          !shouldPrefillSkillCatalog({
            hasPinnedSkill: skillContext.length > 0,
            commandName: run.commandName ?? null,
            orgId: run.orgId,
            engineSessionId,
          }) ||
          run.orgId === null
        ) {
          return null;
        }
        try {
          const entries = await listSkillCatalogForOrg(run.orgId);
          return formatSkillCatalogPrefill(entries, run.prompt);
        } catch (error) {
          console.warn(
            `[worker] skill catalog prefill failed for run ${run.id}; ` +
              "falling back to skills_list discovery:",
            error,
          );
          return null;
        }
      }),
      timedContextOperation("worker.resource_access", () =>
        run.orgId && run.userId
          ? buildResourceAccessSnapshot({
              orgId: run.orgId,
              userId: run.userId,
              runId: run.id,
              resources: run.resolvedResources ?? [],
              repos: run.repos ?? [],
            })
          : Promise.resolve(null),
      ),
    ]);
    const providerSession = providerSessionState.binding ?? undefined;
    const engineSessionId = providerSession?.nativeSessionId ??
      providerSessionState.legacySessionId ?? undefined;
    const turnContext = recall?.rendered ?? "";
    const skillCatalogContext = skillCatalogPage
      ? frameSkillCatalogContext(skillCatalogPage)
      : "";
    const resourceContext = resourceSnapshot
      ? formatResourceAccessContext(resourceSnapshot)
      : "";

    if (turnContext || bootstrapContext || skillContext || skillCatalogContext || resourceContext) {
      console.log(
        `[worker] run ${runId} thread ${run.threadId} scope=${plan?.scope ?? "off"}: ` +
          `turnContext ${turnContext.length} (${recall?.items.length ?? 0} memory items, ` +
          `${recall?.latencyMs ?? 0}ms) + bootstrapContext ${bootstrapContext.length}` +
          ` + skillContext ${skillContext.length} chars` +
          ` + skillCatalogContext ${skillCatalogContext.length} chars` +
          ` + resourceContext ${resourceContext.length} chars`,
      );
    }
    // Retrieval ledger (Phase 3a): durably record + stream what was recalled as a
    // `context.retrieved` native frame. AWAITED before the engine turn (a crash
    // must not lose the record of what context a run used) but OFF the delta
    // fast-path — deltas are published by the adapter during the turn, after this
    // resolves. A persist failure is logged, never fails the run.
    if (plan && recall) {
      await timedContextOperation("worker.context_marker", () =>
        recordContextRetrieval(run.id, run.threadId, plan, run.prompt, recall).catch((err) =>
          console.warn(`[worker] context.retrieved marker persist failed for run ${run.id}:`, err),
        ),
      );
    }
    endContext?.();

    const inputFiles: RunInputFile[] = (await listRunUploads(run.id)).map((upload) => ({
      id: upload.id,
      name: upload.name,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes,
      sha256: upload.sha256,
      storageKey: upload.storageKey,
      sandboxPath: sandboxInputPath(upload.id, upload.name),
    }));

    // The completed-turn capture is enqueued by runs/finalize.ts (transactionally,
    // from the run row's scope) — not here — so it survives a crash in the old
    // completeRun→enqueue gap and covers the mock + boot-reconcile paths too.
    // The timeout aborts the SAME controller the user cancel does; the adapter's
    // AbortSignal fires for either. `wasCancelled()` distinguishes them in
    // runEngine's finalize path (cancel → "Stopped by user", else timed out).
    //
    // SLIDING INACTIVITY window, not wall-clock: an absolute cap killed a
    // healthy 45-tool demo-recording turn at 10min while events were streaming
    // (user-observed via Slack) — "busy" is not "hung". Every published run
    // event resets the timer; the abort fires only after ADAPTER_TIMEOUT_MS of
    // SILENCE, or at the ADAPTER_MAX_MS absolute ceiling (runaway safety).
    const activity = createSlidingInactivityWatchdog(
      ADAPTER_TIMEOUT_MS,
      () => ac.abort(),
    );
    const ceiling = setTimeout(() => ac.abort(), ADAPTER_MAX_MS);
    const onBusEvent = (event: BusEvent): void => {
      if (event.type === "step") activity.touch();
    };
    bus.on(channel(runId), onBusEvent);
    const unsubscribeNativeActivity = subscribeNative(runId, activity.touch);
    try {
      await runEngine(
        runId,
        run.engine,
        run.prompt,
        bootstrapContext,
        turnContext,
        resourceContext,
        skillContext,
        skillCatalogContext,
        run.threadId,
        engineSessionId,
        providerSession,
        run.model,
        run.repos,
        run.resolvedResources,
        run.orgId,
        run.userId,
        inputFiles,
        ac.signal,
        wasCancelled,
        run.commandName ?? null,
        run.commandSessionId ?? null,
        run.commandProvider ?? null,
        run.commandCatalogRevision ?? null,
        firstEngineStep,
        activity.touch,
      );
    } finally {
      bus.off(channel(runId), onBusEvent);
      unsubscribeNativeActivity();
      activity.dispose();
      clearTimeout(ceiling);
    }
  } catch (err) {
    console.error(`[worker] run ${runId} failed before engine completion:`, err);
    const reason =
      err instanceof Error && err.message
        ? `worker error: ${err.message.replace(/\s+/g, " ").slice(0, 180)}`
        : "worker error";
    const finalized = await finalizeRun(runId, "failed", reason, 0).catch((finalizeError) => {
      console.error(`[worker] failed to finalize run ${runId}:`, finalizeError);
      return { applied: false } as const;
    });
    await emitFinalizedEnd(runId, finalized);
  } finally {
    // Free the thread and dispatch its next turn — whatever the outcome.
    cancellers.delete(runId);
    await onRunSettled(runId, run.threadId);
  }
}

type WorkerRun = NonNullable<Awaited<ReturnType<typeof getRun>>>;

async function runChat(
  run: WorkerRun,
  skillContext: string,
  signal: AbortSignal,
  wasCancelled: () => string | null,
): Promise<void> {
  const startedAt = Date.now();
  if (!run.orgId) {
    const finalized = await finalizeRun(run.id, "failed", "chat requires an organization scope", 0);
    await emitFinalizedEnd(run.id, finalized);
    return;
  }

  await setRunStatus(run.id, "running");
  if (!isInternalRunOrigin(run.origin)) {
    publishRunLifecycleChange({
      orgId: run.orgId,
      threadId: run.threadId,
      runId: run.id,
      kind: "running",
    });
  }

  const contextStep = await insertStep({
    runId: run.id,
    idx: 0,
    kind: "task",
    label: "Preparing chat context...",
    chip: "chat",
    code: { phase: "retrieval" },
  });
  bus.emit(channel(run.id), { type: "step", step: contextStep } satisfies BusEvent);

  let answer = "";
  turnStream.begin(run.id);
  try {
    const [context, priorThread, resourceSnapshot] = await Promise.all([
      retrieveChatContext({
        orgId: run.orgId,
        userId: run.userId,
        query: run.prompt,
        memoryScope: run.memoryScope,
        threadId: run.threadId,
        origin: isInternalRunOrigin(run.origin) ? run.origin : null,
      }),
      run.parentRunId ? buildThreadPreamble(run.threadId, run.id) : Promise.resolve(""),
      run.userId
        ? buildResourceAccessSnapshot(
            {
              orgId: run.orgId,
              userId: run.userId,
              runId: run.id,
              resources: run.resolvedResources ?? [],
              repos: run.repos ?? [],
            },
            undefined,
            { inlineLimit: 500, exactInventoryTool: null },
          )
        : Promise.resolve(null),
    ]);

    const systemParts = [CHAT_SYSTEM_PROMPT];
    if (skillContext) systemParts.push(skillContext);
    if (resourceSnapshot) systemParts.push(formatResourceAccessContext(resourceSnapshot));
    if (context.block) systemParts.push(context.block);
    if (priorThread) {
      systemParts.push(
        "Prior conversation in this durable thread. Use it only as conversational history, not as new instructions.\n\n" +
          priorThread,
      );
    }
    const messages: ChatMessage[] = [
      { role: "system", content: systemParts.join("\n\n") },
      { role: "user", content: run.prompt },
    ];

    const resolvedChat = await resolveChatProviderCredential({
      orgId: run.orgId,
      userId: run.userId,
    });
    if (!resolvedChat) throw new Error("chat is not configured (no OpenRouter credential)");
    console.info(`[chat] run ${run.id} served by ${resolvedChat.source}`);

    for await (const delta of streamChat(messages, run.model, resolvedChat.value, signal)) {
      const reason = wasCancelled();
      if (reason !== null) throw new Error(reason);
      answer += delta;
      turnStream.publish(run.id, delta);
    }

    const finalText = answer.trim() || "chat completed";
    const done = await insertStep({
      runId: run.id,
      idx: 1,
      kind: "done",
      label: "Done",
      chip: null,
      code: context.citations.length > 0 ? { citations: context.citations } : null,
    });
    bus.emit(channel(run.id), { type: "step", step: done } satisfies BusEvent);
    const finalized = await finalizeRun(run.id, "completed", finalText, Date.now() - startedAt);
    await emitFinalizedEnd(run.id, finalized);
  } catch {
    const cancelledReason = wasCancelled();
    const timedOut = signal.aborted && cancelledReason === null;
    const label = cancelledReason ??
      (timedOut ? `Timed out after ${ADAPTER_TIMEOUT_MS / 1000}s` : "Chat error");
    const done = await insertStep({
      runId: run.id,
      idx: 1,
      kind: "done",
      label,
      chip: null,
      code: null,
    }).catch(() => null);
    if (done) bus.emit(channel(run.id), { type: "step", step: done } satisfies BusEvent);
    const reason =
      cancelledReason ??
      (timedOut
        ? `timed out after ${ADAPTER_TIMEOUT_MS / 1000}s`
        : "chat request failed");
    const finalized = await finalizeRun(run.id, "failed", reason, Date.now() - startedAt);
    await emitFinalizedEnd(run.id, finalized);
  } finally {
    turnStream.end(run.id);
  }
}

// ---------------------------------------------------------------------------
// Real engine dispatch. Each engine executes REAL shell in an ISOLATED per-run
// workdir (backend/.runs/<runId>/, gitignored, kept after for inspection). A
// hard timeout kills a runaway adapter and marks the run failed.
// ---------------------------------------------------------------------------

export const RUNS_ROOT =
  process.env.RUNS_ROOT?.trim() || join(import.meta.dir, "..", ".runs");

// INACTIVITY window on a single engine run: the abort fires only after this
// much SILENCE on the run's event channel (every step/delta/native frame
// resets it). Overridable (test/ops) like the mock's WORKER_STEP_DELAY_MS knob.
const ADAPTER_TIMEOUT_MS = process.env.ENGINE_TIMEOUT_MS
  ? Number(process.env.ENGINE_TIMEOUT_MS)
  : 600_000; // 10min of silence = hung; long busy turns keep resetting this

// Absolute ceiling regardless of activity — runaway protection only (an agent
// looping forever WITH output would otherwise never time out).
const ADAPTER_MAX_MS = process.env.ENGINE_MAX_MS
  ? Number(process.env.ENGINE_MAX_MS)
  : 4 * 60 * 60_000; // 4h

async function runEngine(
  runId: string,
  engineId: string,
  prompt: string,
  bootstrapContext: string,
  turnContext: string,
  resourceContext: string,
  skillContext: string,
  skillCatalogContext: string,
  threadId: string,
  engineSessionId: string | undefined,
  providerSession: ProviderSessionBinding | undefined,
  model: string,
  repos: string[],
  resolvedResources: EngineRunContext["resolvedResources"],
  orgId: string | null,
  userId: string | null,
  inputFiles: readonly RunInputFile[],
  /** Aborts on the hard timeout OR a user cancel (worker owns the controller). */
  signal: AbortSignal,
  /** Non-null once a user cancel fired — distinguishes cancel from timeout. */
  wasCancelled: () => string | null,
  /** Validated native-command name (Phase 3); non-null => the prompt is delivered verbatim. */
  commandName: string | null,
  /** The native session the command was AUTHORIZED against (fail-closed C3): the adapter
   *  re-checks the LIVE session against this before sending, rejecting a stale command. */
  commandSessionId: string | null,
  /** The provider + catalog snapshot the command was authorized against (fail-closed D4). */
  commandProvider: string | null,
  commandCatalogRevision: number | null,
  /** First adapter-owned step index; the worker reserves index 0 for the
   * immediate real-turn lifecycle marker. */
  firstEngineStep: number,
  /** Canonical outer inactivity pulse shared by steps, deltas, native frames,
   * and adapter-only liveness such as a long-running tool heartbeat. */
  reportActivity: () => void,
): Promise<void> {
  const startedAt = Date.now();

  // SECURITY GATE, defense-in-depth: even if a run row
  // exists with an unsafe/unproven engine (legacy row, non-HTTP channel, direct
  // DB write), refuse to spawn its adapter unless the engine is explicitly enabled
  // (ENABLED_ENGINES). Fail the run closed rather than activating it.
  const engine = engineId as EngineId;
  if (!persistedEngineModelReadyForDispatch(engine, model)) {
    const finalized = await finalizeRun(runId, "failed", `engine/model not ready: ${engineId}/${model}`, 0);
    await emitFinalizedEnd(runId, finalized);
    return;
  }

  if (!resolveProviderRegistration(engineId)) {
    const finalized = await finalizeRun(runId, "failed", `unknown engine: ${engineId}`, 0);
    await emitFinalizedEnd(runId, finalized);
    return;
  }

  // One jailed workdir per THREAD (not per run): successive turns of a
  // conversation share the filesystem AND — because childEnv jails HOME into the
  // workdir — the engine's own on-disk session store. That gives engines with
  // native session support (opencode `-c`) FULL first-party conversation memory
  // across turns, a peer tool-style, instead of a reconstructed text preamble.
  const timing = createRunTimer(runId, threadId);
  const workdir = join(RUNS_ROOT, threadId);
  // Make the workdir a self-contained project root. A `.git` boundary stops an
  // engine (notably OpenCode, which resolves its project by walking UP from cwd)
  // from escaping into the real repo and executing there. Best-effort.
  const endWorkdirBoundary = timing.begin(RUN_TIMING_STAGES.workdirBoundary);
  try {
    endWorkdirBoundary(await ensureRunWorkdir(workdir));
  } catch (error) {
    endWorkdirBoundary(RUN_TIMING_OUTCOMES.failure);
    throw error;
  }

  let idx = firstEngineStep;
  let summary: string | null = null;
  let summaryDuration: number | null = null;

  const emit = async (step: EmitStep): Promise<string | undefined> => {
    // Bail if the run vanished (e.g. deleted) — defensive, keeps FK sane.
    if (!(await getRun(runId))) return undefined;
    const persisted = await insertStep({
      runId,
      idx,
      kind: step.kind,
      label: step.label,
      chip: step.chip ?? null,
      code: step.code_json ?? null,
    });
    idx += 1;
    bus.emit(channel(runId), { type: "step", step: persisted } satisfies BusEvent);
    return persisted.id;
  };

  // Perf Phase 0: stage timer for the adapter's startup phases. Same durable
  // lane as the worker spans (absolute epoch ms keeps the instances coherent).
  const markFirstOutput = createFirstOutputMarker(timing);

  const ctx: EngineRunContext = {
    runId,
    prompt,
    bootstrapContext,
    turnContext,
    resourceContext,
    skillContext,
    skillCatalogContext,
    workdir,
    threadId,
    timing,
    orgId,
    userId,
    inputFiles,
    inputContext: formatInputContext(inputFiles),
    model,
    repos,
    resolvedResources,
    engineSessionId,
    providerSession,
    commandName,
    commandSessionId,
    commandProvider,
    commandCatalogRevision,
    saveProviderSession: createProviderSessionSaver(runId),
    signal,
    emit,
    // In-place step enrichment (same idx → SSE clients upsert): a tool call
    // surfaces the moment it's invoked; its output lands on the SAME step.
    updateStep: async (stepId, code) => {
      const updated = await updateStepCode(stepId, code);
      if (updated) {
        bus.emit(channel(runId), { type: "step", step: updated } satisfies BusEvent);
      }
    },
    // Live-typing channel: synchronous, in-memory, no DB round-trip. SSE
    // subscribers get narration text the instant an engine streams it. `kind`
    // "reasoning" tags thinking so the UI can surface it distinctly.
    publishDelta: (delta, kind) => {
      if (!delta) return;
      markFirstOutput(delta, kind);
      turnStream.publish(runId, delta, kind);
      reportActivity();
    },
    reportActivity,
    setSummary: (s, durationMs) => {
      summary = s;
      summaryDuration = durationMs;
    },
  };

  // Open the run's live delta channel; end() (below, in finally) schedules its
  // grace eviction so a late SSE subscriber can still snapshot the last text.
  turnStream.begin(runId);
  const endTurnSpan = timing.begin("engine.turn");

  try {
    const dispatched = await runProviderTurn(engineId, ctx);
    if (!dispatched) throw new Error(`provider registration disappeared: ${engineId}`);
    // Durable cancellation DOMINATES a coincident provider completion (Blocker 2): a
    // user cancel aborts ctx.signal, but some ACP agents (codex) finish the turn and
    // return NORMALLY instead of erroring. `terminalOnReturn` (pure, tested) resolves
    // the terminal: a durably-accepted cancel -> "Stopped by user" (failed); else the
    // provider's completion. Finalize transactionally (a `completed` also enqueues the
    // durable memory capture in one tx). Exactly ONE finalize + ONE terminal end event;
    // the provider turn already emitted its terminal step, so no duplicate `done`.
    const outcome = terminalOnReturn(wasCancelled(), summary);
    const finalized = await finalizeRun(
      runId,
      outcome.status,
      outcome.summary,
      summaryDuration ?? Date.now() - startedAt,
    );
    await emitFinalizedEnd(runId, finalized);
  } catch (err) {
    // A user cancel wins over a coincident timeout: the abort was requested, so
    // report it honestly as "Stopped by user" rather than a timeout/error.
    const cancelledReason = wasCancelled();
    const cancelled = cancelledReason !== null;
    const timedOut = signal.aborted && !cancelled;
    let redactFailureText = (_text: string): string => "provider request failed";
    try {
      const redactor = await strictOrgSecretRedactor(orgId);
      redactFailureText = redactor.text;
    } catch {
      // Fail closed: never persist or log raw provider errors if secret loading fails.
    }
    // Honest classification: a dropped provider stream (backend restarted under
    // a live turn / stream dropped) is TRANSIENT and resumable, not a provider
    // error. Cancellation + timeout dominate; only the remaining engine errors
    // are classified. See src/engines/turn-failure-classification.ts.
    const failure =
      !cancelled && !timedOut ? classifyTurnFailure(err, redactFailureText) : null;
    if (!cancelled) {
      console.error(
        `[worker] engine ${engineId} run ${runId} failed:`,
        redactFailureText(errorMessage(err)),
      );
    }
    // Terminal done step so the trace shows why it stopped.
    await emit({
      kind: "done",
      label: cancelled
        ? cancelledReason
        : timedOut
          ? `Timed out after ${ADAPTER_TIMEOUT_MS / 1000}s`
          : failure?.kind === "transient"
            ? "Interrupted (resumable)"
            : "Engine error",
      chip: null,
    }).catch(() => {});
    // Surface the REAL failure reason (truncated) — a bare "engine error"
    // summary tells the user nothing actionable (battle-test T6 finding). A
    // transient stream drop reports as resumable rather than an engine error.
    const reason = cancelled
      ? cancelledReason
      : timedOut
        ? `timed out after ${ADAPTER_TIMEOUT_MS / 1000}s`
        : failure?.summary ?? "engine error";
    const finalized = await finalizeRun(runId, "failed", reason, Date.now() - startedAt);
    await emitFinalizedEnd(runId, finalized);
  } finally {
    endTurnSpan();
    turnStream.end(runId);
  }
}
