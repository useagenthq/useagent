import { and, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import {
  runs,
  steps,
  type EngineId,
  type RunStatus,
  type StepKind,
} from "../db/schema";

// ---------------------------------------------------------------------------
// API serialization — preserve the exact snake_case shapes the frontend reads
// (`duration_ms`, `code_json`, `created_at`, …). DB columns are camelCase in
// Drizzle; the wire contract stays identical to the SQLite slice.
// ---------------------------------------------------------------------------

type RunRecord = typeof runs.$inferSelect;
type StepRecord = typeof steps.$inferSelect;

export interface ApiStep {
  id: string;
  run_id: string;
  idx: number;
  kind: StepKind;
  label: string;
  chip: string | null;
  code_json: string | null;
  created_at: string;
}

export interface ApiRun {
  id: string;
  org_id: string | null;
  user_id: string | null;
  prompt: string;
  model: string;
  engine: EngineId;
  status: RunStatus;
  summary: string | null;
  duration_ms: number | null;
  parent_run_id: string | null;
  thread_id: string;
  engine_session_id: string | null;
  created_at: string;
  updated_at: string;
  steps: ApiStep[];
}

function toStep(s: StepRecord): ApiStep {
  return {
    id: s.id,
    run_id: s.runId,
    idx: s.idx,
    kind: s.kind,
    label: s.label,
    chip: s.chip,
    code_json: s.codeJson,
    created_at: s.createdAt.toISOString(),
  };
}

function toRun(r: RunRecord, stepRows: StepRecord[]): ApiRun {
  return {
    id: r.id,
    org_id: r.orgId,
    user_id: r.userId,
    prompt: r.prompt,
    model: r.model,
    engine: r.engine,
    status: r.status,
    summary: r.summary,
    duration_ms: r.durationMs,
    parent_run_id: r.parentRunId,
    thread_id: r.threadId,
    engine_session_id: r.engineSessionId,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    steps: stepRows.map(toStep),
  };
}

/** Attach steps to a set of run rows in a single batched query, preserving the
 * given run order. Shared by the list + thread readers. */
async function withSteps(runRows: RunRecord[]): Promise<ApiRun[]> {
  if (runRows.length === 0) return [];
  const stepRows = await db
    .select()
    .from(steps)
    .where(
      inArray(
        steps.runId,
        runRows.map((r) => r.id),
      ),
    )
    .orderBy(steps.idx);

  const byRun = new Map<string, StepRecord[]>();
  for (const s of stepRows) {
    const list = byRun.get(s.runId) ?? [];
    list.push(s);
    byRun.set(s.runId, list);
  }
  return runRows.map((r) => toRun(r, byRun.get(r.id) ?? []));
}

// ---------------------------------------------------------------------------
// Boot recovery
// ---------------------------------------------------------------------------

/** Honest fallback summary for a run we cannot reconcile after an unclean
 * shutdown: it lost its in-memory worker and the native session (if any) is
 * unreachable or unfinished, so the log stays truthful and points the user at
 * the recovery action — replying resumes the same thread/session. */
export const STALE_SUMMARY =
  "Interrupted — the backend restarted mid-run. Reply to continue in this thread.";

/** Timestamp of a run's most recent step — the "our last activity" watermark a
 * reconciler compares a native completed-message time against. */
export async function getLastStepAt(runId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: steps.createdAt })
    .from(steps)
    .where(eq(steps.runId, runId))
    .orderBy(desc(steps.createdAt))
    .limit(1);
  return row?.at ?? null;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function createRun(
  input: {
    id: string;
    prompt: string;
    model: string;
    engine: EngineId;
    orgId: string | null;
    userId: string | null;
    parentRunId: string | null;
    threadId: string;
  },
  /** Run the insert inside a caller's transaction (durable-command acceptance
   *  commits the command + run atomically). Defaults to the shared pool. */
  exec: Executor = db,
): Promise<void> {
  await exec.insert(runs).values({
    id: input.id,
    prompt: input.prompt,
    model: input.model,
    engine: input.engine,
    status: "queued",
    orgId: input.orgId,
    userId: input.userId,
    parentRunId: input.parentRunId,
    threadId: input.threadId,
  });
}

export async function getRun(id: string): Promise<RunRecord | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row ?? null;
}

/** Persist the engine's own session id for a run (reference bot's
 * set_resume_session_id model, durably) so the thread's next turn can resume the
 * engine's native conversation explicitly by id. */
export async function setRunEngineSession(id: string, sessionId: string): Promise<void> {
  await db.update(runs).set({ engineSessionId: sessionId }).where(eq(runs.id, id));
}

/** Persist the sandbox a run executed in (thread→sandbox mapping, durable). */
export async function setRunSandbox(id: string, sandboxId: string): Promise<void> {
  await db.update(runs).set({ sandboxId }).where(eq(runs.id, id));
}

/** The most recent sandbox id recorded in this thread — the box holding the
 * conversation's workspace and resident engine server. Survives restarts. */
export async function getThreadSandbox(threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ sid: runs.sandboxId })
    .from(runs)
    .where(and(eq(runs.threadId, threadId), isNotNull(runs.sandboxId)))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return row?.sid ?? null;
}

/** The most recent engine session id recorded in this thread FOR THE SAME
 * engine (a thread can mix engines; sessions don't transfer across them).
 * Null → the adapter starts a fresh native session with the composed preamble. */
export async function getThreadEngineSession(
  threadId: string,
  engine: string,
  excludeRunId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ sid: runs.engineSessionId })
    .from(runs)
    .where(
      and(
        eq(runs.threadId, threadId),
        eq(runs.engine, engine as RunRecord["engine"]),
        ne(runs.id, excludeRunId),
        isNotNull(runs.engineSessionId),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return row?.sid ?? null;
}

/** Org-scoped fetch — used by request handlers so one org can't read another's
 * run. Returns null (→ 404) for a cross-org id, indistinguishable from missing. */
export async function getRunForOrg(
  orgId: string,
  id: string,
): Promise<RunRecord | null> {
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

export async function getRunWithSteps(
  orgId: string,
  id: string,
): Promise<ApiRun | null> {
  const run = await getRunForOrg(orgId, id);
  if (!run) return null;
  const stepRows = await db
    .select()
    .from(steps)
    .where(eq(steps.runId, id))
    .orderBy(steps.idx);
  return toRun(run, stepRows);
}

/** List runs for an org, newest first. By default only THREAD ROOTS (runs with
 * no parent) so the list shows one entry per conversation; `all` includes every
 * run in every thread. */
export async function listRunsWithSteps(
  orgId: string,
  opts: { all?: boolean } = {},
): Promise<ApiRun[]> {
  const where = opts.all
    ? eq(runs.orgId, orgId)
    : and(eq(runs.orgId, orgId), isNull(runs.parentRunId));
  const runRows = await db
    .select()
    .from(runs)
    .where(where)
    .orderBy(desc(runs.createdAt), desc(runs.id));
  return withSteps(runRows);
}

/** Every run in the thread that `id` belongs to, oldest→newest, with steps.
 * Org-scoped: a cross-org (or missing) id resolves to null (→ 404). */
export async function getThreadForRun(
  orgId: string,
  id: string,
): Promise<ApiRun[] | null> {
  const run = await getRunForOrg(orgId, id);
  if (!run) return null;
  const runRows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.threadId, run.threadId), eq(runs.orgId, orgId)))
    .orderBy(runs.createdAt, runs.id);
  return withSteps(runRows);
}

// ---------------------------------------------------------------------------
// Thread context — the engine's view of prior turns. Prompts are stored clean;
// the composed preamble below is what an adapter prepends to its engine prompt,
// so context lives at invocation time and never nests into the stored prompt.
// ---------------------------------------------------------------------------

/** Keep the preamble bounded: at most the last N turns, and under ~MAX chars
 * with the OLDEST turns dropped first. */
const THREAD_MAX_TURNS = 6;
const THREAD_MAX_CHARS = 4000;

/** Compose the engine context preamble for a run: walk its thread's PRIOR turns
 * (every other run in the thread, oldest→newest) and render each as
 * `User: <prompt>\nResult: <summary ?? 'no summary'>`. Returns "" when there is
 * no prior context (a thread root). */
export async function buildThreadPreamble(
  threadId: string,
  currentRunId: string,
): Promise<string> {
  const rows = await db
    .select({ prompt: runs.prompt, summary: runs.summary })
    .from(runs)
    .where(and(eq(runs.threadId, threadId), ne(runs.id, currentRunId)))
    .orderBy(runs.createdAt, runs.id);
  if (rows.length === 0) return "";

  // Keep the most recent turns, then trim oldest-first to the char budget.
  let blocks = rows
    .slice(-THREAD_MAX_TURNS)
    .map((r) => `User: ${r.prompt}\nYou replied: ${r.summary ?? "no summary"}`);
  while (blocks.length > 1 && blocks.join("\n\n").length > THREAD_MAX_CHARS) {
    blocks = blocks.slice(1);
  }
  // Framing is load-bearing: a weak "context:" note gets ignored and the engine
  // claims it "starts fresh" when asked what happened above. State plainly that
  // this IS its own history of THIS session and that "above / earlier /
  // previously" refers to it.
  return (
    `This is an ONGOING conversation, and below is YOUR OWN history of it — the ` +
    `previous turns between the user and you (oldest first, most recent last). ` +
    `You DO have this context: when the user says "above", "earlier", or ` +
    `"previously", they mean these turns — answer from them instead of saying ` +
    `you lack history. (Only work outside this conversation is unknown to you ` +
    `unless a team-memory block is provided above.)\n\n${blocks.join("\n\n")}\n\n---\n\n`
  );
}

export async function getStepsApi(runId: string): Promise<ApiStep[]> {
  const rows = await db
    .select()
    .from(steps)
    .where(eq(steps.runId, runId))
    .orderBy(steps.idx);
  return rows.map(toStep);
}

export async function setRunStatus(id: string, status: RunStatus): Promise<void> {
  await db
    .update(runs)
    .set({ status, updatedAt: new Date() })
    .where(eq(runs.id, id));
}

export async function completeRun(
  id: string,
  status: RunStatus,
  summary: string,
  durationMs: number,
  /** Run inside a caller's transaction so finalization commits the terminal
   *  status and its durable side-effects (memory capture, slack reply) atomically
   *  (see runs/finalize.ts). Defaults to the shared pool. */
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(runs)
    .set({ status, summary, durationMs, updatedAt: new Date() })
    .where(eq(runs.id, id));
}

/** Replace a step's code_json in place (same id/idx). Serves the tool_call →
 * tool_result contract: the step appears when the tool is INVOKED, and its
 * output is attached to the SAME step when the tool finishes. */
export async function updateStepCode(
  id: string,
  code: unknown,
): Promise<ApiStep | null> {
  const codeJson = code == null ? null : JSON.stringify(code);
  const [row] = await db
    .update(steps)
    .set({ codeJson })
    .where(eq(steps.id, id))
    .returning();
  return row ? toStep(row) : null;
}

export async function insertStep(step: {
  runId: string;
  idx: number;
  kind: StepKind;
  label: string;
  chip: string | null;
  code: unknown | null;
}): Promise<ApiStep> {
  const id = crypto.randomUUID();
  const codeJson = step.code == null ? null : JSON.stringify(step.code);
  const [row] = await db
    .insert(steps)
    .values({
      id,
      runId: step.runId,
      idx: step.idx,
      kind: step.kind,
      label: step.label,
      chip: step.chip,
      codeJson,
    })
    .returning();
  return toStep(row!);
}
