import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  buildThreadPreamble,
  getRun,
  getThreadEngineSession,
  insertStep,
  setRunEngineSession,
  setRunStatus,
  updateStepCode,
  type ApiStep,
} from "./runs/repo";
import type { RunStatus, StepKind } from "./db/schema";
import { adapters } from "./engines";
import { isEngineEnabled } from "./env";
import type { EmitStep, EngineRunContext } from "./engines/types";
import { recallScopedMemory } from "./memory/team-memory";
import { resolveScopedMemory } from "./memory/scope";
import { recordContextRetrieval } from "./memory/retrieval-ledger";
import { getPinnedRevision } from "./skills/repo";
import { formatSkillMarkdown, frameSkillContext } from "./skills/format";
import { recordSkillLoaded } from "./skills/skill-loaded";
import { finalizeRun } from "./runs/finalize";
import { turnStream } from "./runs/turn-stream";
import { publishThreadChange } from "./runs/thread-signals";
import { claimNextRun, settleCommandForRun } from "./commands/dispatch";

// ---------------------------------------------------------------------------
// Event bus — the worker pushes trace events here; SSE clients subscribe.
// ---------------------------------------------------------------------------

export type BusEvent =
  | { type: "step"; step: ApiStep }
  | { type: "end"; status: RunStatus };

export const bus = new EventEmitter();
bus.setMaxListeners(0); // any number of concurrent SSE subscribers

export const channel = (runId: string): string => `run:${runId}`;

// Global lifecycle signal: fired once per run the instant its actor is spawned,
// BEFORE any step/end event, carrying the runId. Connectors (src/connectors/*)
// subscribe here to attach a per-run feed without threading through every run
// creation path (API, Slack, schedules). Distinct from the per-run `channel`.
export const RUN_SPAWNED = "run:spawned";

// ---------------------------------------------------------------------------
// Actor-lite registry: one logical worker per run id.
//
// This is a STUB. The scripted trace below stands in for the real Claude Agent
// SDK loop (migration step 2). It exists to prove the durable event log + SSE
// streaming path end-to-end — now writing into Postgres via Drizzle.
// ---------------------------------------------------------------------------

interface ScriptedStep {
  kind: StepKind;
  label: string;
  chip: string | null;
  code?: unknown;
  /** delay before this step is emitted, in ms */
  delayMs: number;
}

const SCRIPT: ScriptedStep[] = [
  { kind: "command", label: "Cloning repository", chip: "git", delayMs: 1600 },
  { kind: "command", label: "Running Command", chip: "script", delayMs: 1800 },
  { kind: "task", label: "Analyzing codebase", chip: "task", delayMs: 1600 },
  { kind: "file", label: "Editing file", chip: "file", delayMs: 1600 },
  { kind: "file", label: "Editing file", chip: "file", delayMs: 1400 },
  { kind: "file", label: "Editing file", chip: "file", delayMs: 1400 },
  {
    kind: "command",
    label: "Running Command",
    chip: "script",
    code: { taskId: "1", status: "completed" },
    delayMs: 1800,
  },
  { kind: "done", label: "Done", chip: null, delayMs: 300 },
];

const registry = new Map<string, Promise<void>>();

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

/** Sleep that resolves early if `signal` aborts — so a scripted mock turn stops
 *  within one step of a cancel instead of running to its next tick. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Optional test/dev knob: collapse the scripted per-step delay so a run
// completes near-instantly. Unset in normal operation (real cadence preserved).
const STEP_DELAY_OVERRIDE_MS = process.env.WORKER_STEP_DELAY_MS
  ? Number(process.env.WORKER_STEP_DELAY_MS)
  : null;

function summarize(steps: ScriptedStep[]): string {
  const work = steps.filter((s) => s.kind !== "done");
  const files = work.filter((s) => s.kind === "file").length;
  const commands = work.filter((s) => s.kind === "command").length;
  return `${work.length} tools, edited ${files} files, ran ${commands} commands`;
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

/** Claim the thread's next queued command (if the thread is now idle) and spawn
 *  it. Called after a run settles, on accept, and on boot. Returns the run id
 *  dispatched, or null if the thread is busy/empty. */
export async function pumpThread(threadId: string): Promise<string | null> {
  const next = await claimNextRun(threadId);
  if (next) spawnWorker(next);
  return next;
}

/** Mark the settled run's command completed (or requeued) and pump the thread's
 *  next turn. Runs in every terminal path (success, failure, timeout). */
async function onRunSettled(runId: string, threadId: string): Promise<void> {
  await settleCommandForRun(runId).catch((err) =>
    console.error(`[worker] settle command for run ${runId} failed:`, err),
  );
  await pumpThread(threadId).catch((err) =>
    console.error(`[worker] pump thread ${threadId} failed:`, err),
  );
}

/** Start a real engine turn at the trusted worker boundary, before any optional
 * context or runtime preparation can add seconds of silent UI time. The row is
 * durable (so reload/reconnect sees the same state) and also published live.
 * Returns the next step index for the engine adapter. */
export async function beginEngineRun(runId: string, threadId: string): Promise<number> {
  await setRunStatus(runId, "running");
  publishThreadChange(threadId, { runId, kind: "running" });
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

  try {
    // Match mature agent UIs: expose a truthful, durable lifecycle row
    // immediately, then do memory/skill/runtime work behind it. Mock retains its
    // exact scripted fixture; every real engine starts its own rows at index 1.
    const firstEngineStep =
      run.engine === "mock" ? 0 : await beginEngineRun(run.id, run.threadId);

    // Skill context (Phase 0 slice 0.1): resolve + record the run's pinned skill
    // FIRST, for ANY engine. A run that selected a skill "loaded" it regardless of
    // harness — mock ignores context, but the durable `skill.loaded` marker and
    // provenance still hold. `skillContext` is the SKILL.md-shaped INSTRUCTIONS,
    // injected below via the per-turn seam SEPARATELY from the (clean) user prompt.
    const pinnedSkill =
      run.skillId && run.skillVersion != null
        ? await getPinnedRevision(run.skillId, run.skillVersion)
        : null;
    let skillContext = "";
    if (pinnedSkill) {
      const markdown = formatSkillMarkdown(pinnedSkill.content);
      skillContext = frameSkillContext(markdown);
      // Emit skill.loaded (metadata only, no body) on the durable native lane so
      // it renders as a timeline row and survives reconnect. AWAITED here (before
      // the engine runs, well off the delta fast-path) so a crash can't lose the
      // evidence that a skill governed this run; a persist failure is logged and
      // never fails the run.
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
    }

    // `mock` is the scripted trace and ignores context entirely. It IS
    // cancellable — the abortable sleep + signal make a live mock turn stop.
    if (run.engine === "mock") {
      await runMock(runId, run.threadId, ac.signal, wasCancelled);
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
    const [recall, bootstrapContext] = await Promise.all([
      // Layered recall (new_mem_prompt.md 6.2): Tencent L0 (immediate ground
      // evidence, incl. explicit "remember X") + L1 (distilled) searched in
      // parallel and merged, so a freshly-taught fact is injected into a NEW
      // thread's context before L1 extraction even finishes.
      plan ? recallScopedMemory(run.prompt, plan.readPools) : Promise.resolve(null),
      run.parentRunId ? buildThreadPreamble(run.threadId, run.id) : Promise.resolve(""),
    ]);
    const turnContext = recall?.rendered ?? "";

    if (turnContext || bootstrapContext || skillContext) {
      console.log(
        `[worker] run ${runId} thread ${run.threadId} scope=${plan?.scope ?? "off"}: ` +
          `turnContext ${turnContext.length} (${recall?.items.length ?? 0} memory items, ` +
          `${recall?.latencyMs ?? 0}ms) + bootstrapContext ${bootstrapContext.length}` +
          ` + skillContext ${skillContext.length} chars`,
      );
    }
    // Retrieval ledger (Phase 3a): durably record + stream what was recalled as a
    // `context.retrieved` native frame. AWAITED before the engine turn (a crash
    // must not lose the record of what context a run used) but OFF the delta
    // fast-path — deltas are published by the adapter during the turn, after this
    // resolves. A persist failure is logged, never fails the run.
    if (plan && recall) {
      await recordContextRetrieval(run.id, run.threadId, plan, run.prompt, recall).catch((err) =>
        console.warn(`[worker] context.retrieved marker persist failed for run ${run.id}:`, err),
      );
    }

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
    let timer = setTimeout(() => ac.abort(), ADAPTER_TIMEOUT_MS);
    const ceiling = setTimeout(() => ac.abort(), ADAPTER_MAX_MS);
    const onActivity = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => ac.abort(), ADAPTER_TIMEOUT_MS);
    };
    bus.on(channel(runId), onActivity);
    try {
      await runEngine(
        runId,
        run.engine,
        run.prompt,
        bootstrapContext,
        turnContext,
        skillContext,
        run.threadId,
        run.model,
        run.repos,
        run.orgId,
        run.userId,
        ac.signal,
        wasCancelled,
        run.commandName ?? null,
        run.commandSessionId ?? null,
        run.commandProvider ?? null,
        run.commandCatalogRevision ?? null,
        firstEngineStep,
      );
    } finally {
      bus.off(channel(runId), onActivity);
      clearTimeout(timer);
      clearTimeout(ceiling);
    }
  } finally {
    // Free the thread and dispatch its next turn — whatever the outcome.
    cancellers.delete(runId);
    await onRunSettled(runId, run.threadId);
  }
}

async function runMock(
  runId: string,
  threadId: string,
  signal: AbortSignal,
  wasCancelled: () => string | null,
): Promise<void> {
  const startedAt = Date.now();
  await setRunStatus(runId, "running");
  // Wake connected thread streams to re-project the queued→running transition
  // (the status change carries no worker step of its own).
  publishThreadChange(threadId, { runId, kind: "running" });

  let idx = 0;
  try {
    for (const scripted of SCRIPT) {
      await abortableSleep(STEP_DELAY_OVERRIDE_MS ?? scripted.delayMs, signal);
      // A user cancel settles the run honestly as "Stopped by user".
      const reason = wasCancelled();
      if (reason !== null) {
        const done = await insertStep({
          runId,
          idx,
          kind: "done",
          label: reason,
          chip: null,
          code: null,
        }).catch(() => null);
        if (done) bus.emit(channel(runId), { type: "step", step: done } satisfies BusEvent);
        await finalizeRun(runId, "failed", reason, Date.now() - startedAt);
        bus.emit(channel(runId), { type: "end", status: "failed" } satisfies BusEvent);
        return;
      }
      // Bail if the run vanished (e.g. deleted) — defensive, keeps FK sane.
      if (!(await getRun(runId))) return;
      const step = await insertStep({
        runId,
        idx,
        kind: scripted.kind,
        label: scripted.label,
        chip: scripted.chip,
        code: scripted.code ?? null,
      });
      idx += 1;
      bus.emit(channel(runId), { type: "step", step } satisfies BusEvent);
    }

    await finalizeRun(runId, "completed", summarize(SCRIPT), Date.now() - startedAt);
    bus.emit(channel(runId), { type: "end", status: "completed" } satisfies BusEvent);
  } catch (err) {
    console.error(`[worker] run ${runId} failed:`, err);
    await finalizeRun(runId, "failed", "worker error", Date.now() - startedAt);
    bus.emit(channel(runId), { type: "end", status: "failed" } satisfies BusEvent);
  }
}

// ---------------------------------------------------------------------------
// Real engine dispatch. Each engine executes REAL shell in an ISOLATED per-run
// workdir (backend/.runs/<runId>/, gitignored, kept after for inspection). A
// hard timeout kills a runaway adapter and marks the run failed.
// ---------------------------------------------------------------------------

export const RUNS_ROOT = join(import.meta.dir, "..", ".runs");

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
  skillContext: string,
  threadId: string,
  model: string,
  repos: string[],
  orgId: string | null,
  userId: string | null,
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
): Promise<void> {
  const startedAt = Date.now();

  // Explicit native-session resume (reference bot's set_resume_session_id model): the
  // thread's previous turn on the SAME engine recorded its engine session id in
  // the DB; hand it to the adapter so it resumes deterministically by id.
  const engineSessionId =
    (await getThreadEngineSession(threadId, engineId, runId)) ?? undefined;

  // SECURITY GATE (final_harness.md P0), defense-in-depth: even if a run row
  // exists with an unsafe/unproven engine (legacy row, non-HTTP channel, direct
  // DB write), refuse to spawn its adapter unless the engine is explicitly enabled
  // (ENABLED_ENGINES). Fail the run closed rather than activating it.
  if (!isEngineEnabled(engineId)) {
    await finalizeRun(runId, "failed", `engine not enabled: ${engineId}`, 0);
    bus.emit(channel(runId), { type: "end", status: "failed" } satisfies BusEvent);
    return;
  }

  const adapter = adapters[engineId];
  if (!adapter) {
    await finalizeRun(runId, "failed", `unknown engine: ${engineId}`, 0);
    bus.emit(channel(runId), { type: "end", status: "failed" } satisfies BusEvent);
    return;
  }

  // One jailed workdir per THREAD (not per run): successive turns of a
  // conversation share the filesystem AND — because childEnv jails HOME into the
  // workdir — the engine's own on-disk session store. That gives engines with
  // native session support (opencode `-c`) FULL first-party conversation memory
  // across turns, reference bot-style, instead of a reconstructed text preamble.
  const workdir = join(RUNS_ROOT, threadId);
  await mkdir(workdir, { recursive: true });
  // Make the workdir a self-contained project root. A `.git` boundary stops an
  // engine (notably OpenCode, which resolves its project by walking UP from cwd)
  // from escaping into the real repo and executing there. Best-effort.
  await Bun.spawn(["git", "init", "-q"], {
    cwd: workdir,
    stdout: "ignore",
    stderr: "ignore",
  }).exited.catch(() => {});

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

  const ctx: EngineRunContext = {
    runId,
    prompt,
    bootstrapContext,
    turnContext,
    skillContext,
    workdir,
    threadId,
    orgId,
    userId,
    model,
    repos,
    engineSessionId,
    commandName,
    commandSessionId,
    commandProvider,
    commandCatalogRevision,
    // Durable fire-and-forget: the id is saved the moment the engine reveals it,
    // so even a later-failing run leaves a resumable session for the next turn.
    saveEngineSessionId: (sid) => {
      void setRunEngineSession(runId, sid).catch((err) =>
        console.error(`[worker] failed to persist engine session id for ${runId}:`, err),
      );
    },
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
    // subscribers get narration text the instant an engine streams it.
    publishDelta: (delta) => turnStream.publish(runId, delta),
    setSummary: (s, durationMs) => {
      summary = s;
      summaryDuration = durationMs;
    },
  };

  // Open the run's live delta channel; end() (below, in finally) schedules its
  // grace eviction so a late SSE subscriber can still snapshot the last text.
  turnStream.begin(runId);

  try {
    await adapter.run(ctx);
    // Durable cancellation DOMINATES a coincident provider completion (Blocker 2): a
    // user cancel aborts ctx.signal, but some ACP agents (codex) finish the turn and
    // return NORMALLY instead of erroring. `terminalOnReturn` (pure, tested) resolves
    // the terminal: a durably-accepted cancel -> "Stopped by user" (failed); else the
    // provider's completion. Finalize transactionally (a `completed` also enqueues the
    // durable memory capture in one tx). Exactly ONE finalize + ONE terminal end event;
    // the adapter already emitted its terminal step, so no duplicate `done`.
    const outcome = terminalOnReturn(wasCancelled(), summary);
    await finalizeRun(runId, outcome.status, outcome.summary, summaryDuration ?? Date.now() - startedAt);
    bus.emit(channel(runId), { type: "end", status: outcome.status } satisfies BusEvent);
  } catch (err) {
    // A user cancel wins over a coincident timeout: the abort was requested, so
    // report it honestly as "Stopped by user" rather than a timeout/error.
    const cancelledReason = wasCancelled();
    const cancelled = cancelledReason !== null;
    const timedOut = signal.aborted && !cancelled;
    if (!cancelled) console.error(`[worker] engine ${engineId} run ${runId} failed:`, err);
    // Terminal done step so the trace shows why it stopped.
    await emit({
      kind: "done",
      label: cancelled
        ? cancelledReason
        : timedOut
          ? `Timed out after ${ADAPTER_TIMEOUT_MS / 1000}s`
          : "Engine error",
      chip: null,
    }).catch(() => {});
    // Surface the REAL failure reason (truncated) — a bare "engine error"
    // summary tells the user nothing actionable (battle-test T6 finding).
    const reason = cancelled
      ? cancelledReason
      : timedOut
        ? `timed out after ${ADAPTER_TIMEOUT_MS / 1000}s`
        : err instanceof Error && err.message
          ? `error: ${err.message.replace(/\s+/g, " ").slice(0, 180)}`
          : "engine error";
    await finalizeRun(runId, "failed", reason, Date.now() - startedAt);
    bus.emit(channel(runId), { type: "end", status: "failed" } satisfies BusEvent);
  } finally {
    turnStream.end(runId);
  }
}
