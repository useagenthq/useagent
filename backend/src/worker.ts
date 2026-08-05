import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  buildThreadPreamble,
  completeRun,
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
import type { EmitStep, EngineRunContext } from "./engines/types";
import { resolveMemoryIdentity, searchTeamMemory } from "./memory/team-memory";
import { recordContextRetrieval } from "./memory/retrieval-ledger";
import { finalizeRun } from "./runs/finalize";
import { turnStream } from "./runs/turn-stream";
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

// Optional test/dev knob: collapse the scripted per-step delay so a run
// completes near-instantly. Unset in normal operation (real cadence preserved).
const STEP_DELAY_OVERRIDE_MS = process.env.WORKER_STEP_DELAY_MS
  ? Number(process.env.WORKER_STEP_DELAY_MS)
  : null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function summarize(steps: ScriptedStep[]): string {
  const work = steps.filter((s) => s.kind !== "done");
  const files = work.filter((s) => s.kind === "file").length;
  const commands = work.filter((s) => s.kind === "command").length;
  return `${work.length} tools, edited ${files} files, ran ${commands} commands`;
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

async function runWorker(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) return; // deleted before the actor started

  try {
    // `mock` is the scripted trace and ignores context entirely.
    if (run.engine === "mock") {
      await runMock(runId);
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
    // Identity is per-run (userId from the run row, threadId as MemoryCore
    // session, runId provenance); null when memory is disabled.
    const identity = resolveMemoryIdentity(run);
    const [recall, bootstrapContext] = await Promise.all([
      identity ? searchTeamMemory(run.prompt, identity) : Promise.resolve(null),
      run.parentRunId ? buildThreadPreamble(run.threadId, run.id) : Promise.resolve(""),
    ]);
    const turnContext = recall?.rendered ?? "";
    if (turnContext || bootstrapContext) {
      console.log(
        `[worker] run ${runId} thread ${run.threadId}: turnContext ${turnContext.length}` +
          ` (${recall?.items.length ?? 0} memory items, ${recall?.latencyMs ?? 0}ms) +` +
          ` bootstrapContext ${bootstrapContext.length} chars`,
      );
    }
    // Retrieval ledger (Phase 3a): durably record + stream what was recalled as a
    // `context.retrieved` native frame. Fire-and-forget — never blocks/fails the run.
    if (identity && recall) {
      void recordContextRetrieval(run.id, run.threadId, identity, run.prompt, recall);
    }

    await runEngine(
      runId,
      run.engine,
      run.prompt,
      bootstrapContext,
      turnContext,
      run.threadId,
      run.model,
    );
  } finally {
    // Free the thread and dispatch its next turn — whatever the outcome.
    await onRunSettled(runId, run.threadId);
  }
}

async function runMock(runId: string): Promise<void> {
  const startedAt = Date.now();
  await setRunStatus(runId, "running");

  let idx = 0;
  try {
    for (const scripted of SCRIPT) {
      await sleep(STEP_DELAY_OVERRIDE_MS ?? scripted.delayMs);
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
    await completeRun(runId, "failed", "worker error", Date.now() - startedAt);
    bus.emit(channel(runId), { type: "end", status: "failed" } satisfies BusEvent);
  }
}

// ---------------------------------------------------------------------------
// Real engine dispatch. Each engine executes REAL shell in an ISOLATED per-run
// workdir (backend/.runs/<runId>/, gitignored, kept after for inspection). A
// hard timeout kills a runaway adapter and marks the run failed.
// ---------------------------------------------------------------------------

export const RUNS_ROOT = join(import.meta.dir, "..", ".runs");

// Hard cap on a single engine run. On expiry the adapter's AbortSignal fires,
// killing its subprocess / SDK loop; the run is marked failed with a done step.
// Overridable (test/ops) like the mock's WORKER_STEP_DELAY_MS knob.
const ADAPTER_TIMEOUT_MS = process.env.ENGINE_TIMEOUT_MS
  ? Number(process.env.ENGINE_TIMEOUT_MS)
  : 600_000; // resident engines make long fanout turns legitimate

async function runEngine(
  runId: string,
  engineId: string,
  prompt: string,
  bootstrapContext: string,
  turnContext: string,
  threadId: string,
  model: string,
): Promise<void> {
  const startedAt = Date.now();
  await setRunStatus(runId, "running");

  // Explicit native-session resume (reference bot's set_resume_session_id model): the
  // thread's previous turn on the SAME engine recorded its engine session id in
  // the DB; hand it to the adapter so it resumes deterministically by id.
  const engineSessionId =
    (await getThreadEngineSession(threadId, engineId, runId)) ?? undefined;

  const adapter = adapters[engineId];
  if (!adapter) {
    await completeRun(runId, "failed", `unknown engine: ${engineId}`, 0);
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

  let idx = 0;
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

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ADAPTER_TIMEOUT_MS);

  const ctx: EngineRunContext = {
    runId,
    prompt,
    bootstrapContext,
    turnContext,
    workdir,
    threadId,
    model,
    engineSessionId,
    // Durable fire-and-forget: the id is saved the moment the engine reveals it,
    // so even a later-failing run leaves a resumable session for the next turn.
    saveEngineSessionId: (sid) => {
      void setRunEngineSession(runId, sid).catch((err) =>
        console.error(`[worker] failed to persist engine session id for ${runId}:`, err),
      );
    },
    signal: ac.signal,
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
    clearTimeout(timer);
    const finalSummary = summary ?? "run completed";
    // Finalize transactionally: commit `completed` AND enqueue the durable memory
    // capture (idempotent by runId) in one transaction, so a crash can never leave
    // a completed run with no capture (the old completeRun→enqueue gap). See
    // runs/finalize.ts.
    await finalizeRun(runId, "completed", finalSummary, summaryDuration ?? Date.now() - startedAt);
    bus.emit(channel(runId), { type: "end", status: "completed" } satisfies BusEvent);
  } catch (err) {
    clearTimeout(timer);
    const timedOut = ac.signal.aborted;
    console.error(`[worker] engine ${engineId} run ${runId} failed:`, err);
    // Terminal done step so the trace shows why it stopped.
    await emit({
      kind: "done",
      label: timedOut
        ? `Timed out after ${ADAPTER_TIMEOUT_MS / 1000}s`
        : "Engine error",
      chip: null,
    }).catch(() => {});
    // Surface the REAL failure reason (truncated) — a bare "engine error"
    // summary tells the user nothing actionable (battle-test T6 finding).
    const reason = timedOut
      ? `timed out after ${ADAPTER_TIMEOUT_MS / 1000}s`
      : err instanceof Error && err.message
        ? `error: ${err.message.replace(/\s+/g, " ").slice(0, 180)}`
        : "engine error";
    await completeRun(runId, "failed", reason, Date.now() - startedAt);
    bus.emit(channel(runId), { type: "end", status: "failed" } satisfies BusEvent);
  } finally {
    turnStream.end(runId);
  }
}
