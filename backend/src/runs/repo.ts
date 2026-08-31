import type {
  ApiRun,
  ApiRunSummary,
  ApiStep,
  ApiThreadOutlineTurn,
} from "@useagent/agent-client/wire";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { db, type Executor } from "../db/client";
import {
  commands,
  runs,
  steps,
  type EngineId,
  type MemoryScope,
  type RunStatus,
  type StepKind,
} from "../db/schema";
import { parseRepoRef } from "../github/repo-ref";
import type { RunResource } from "../resources/types";
import { ensureProject } from "../projects/repo";
import { listUploadsForRuns, type RunUploadDescriptor } from "../uploads/repo";
import { publicRunCondition } from "./visibility";
import { MODEL_QUALIFICATION_RUN_ORIGIN } from "./origin";
export { completeRun, pinSkillToActiveRun, setRunStatus } from "./run-state";

// The run/step API shapes are the agent-client WIRE CONTRACT (single source of
// truth; packages never import apps). Re-exported so the many backend modules that
// read them from `../runs/repo` keep one import path; the serializers below
// `satisfies` them, so any field or optionality drift is a compile error here.
export type {
  ApiRun,
  ApiRunSummary,
  ApiStep,
  ApiThreadOutlineTurn,
} from "@useagent/agent-client/wire";

// ---------------------------------------------------------------------------
// API serialization — preserve the exact snake_case shapes the frontend reads
// (`duration_ms`, `code_json`, `created_at`, …). DB columns are camelCase in
// Drizzle; the wire contract stays identical to the SQLite slice.
// ---------------------------------------------------------------------------

type RunRecord = typeof runs.$inferSelect;
type StepRecord = typeof steps.$inferSelect;

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
  } satisfies ApiStep;
}

function toRun(
  r: RunRecord,
  stepRows: StepRecord[],
  uploads: RunUploadDescriptor[] = [],
  childSession = false,
): ApiRun {
  // Stored refs may carry a branch ("owner/name:branch"); decode so the wire
  // stays clean "owner/name" and the branch surfaces in `repo_specs` instead.
  const specs = r.repos.map(parseRepoRef);
  return {
    id: r.id,
    org_id: r.orgId,
    user_id: r.userId,
    project_id: r.projectId,
    prompt: r.prompt,
    model: r.model,
    engine: r.engine,
    status: r.status,
    summary: r.summary,
    duration_ms: r.durationMs,
    parent_run_id: r.parentRunId,
    child_session: childSession,
    thread_id: r.threadId,
    engine_session_id: r.engineSessionId,
    repo: r.repo ? parseRepoRef(r.repo).repo : null,
    repos: specs.map((s) => s.repo),
    repo_specs: specs,
    resolved_resources: r.resolvedResources ?? [],
    memory_scope: r.memoryScope,
    skill_id: r.skillId,
    skill_version: r.skillVersion,
    skill_content_hash: r.skillContentHash,
    uploads,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
    steps: stepRows.map(toStep),
  } satisfies ApiRun;
}

/** Idempotency-key namespace `createChildSession` accepts its runs under - the
 * durable mark that a run is a gateway child session. Owned here (the lowest
 * layer that reads it) so `child-sessions.ts` can import without a module cycle. */
export const CHILD_SESSION_IDEMPOTENCY_PREFIX = "child-session";

/** Which of these runs are gateway child sessions: their accepted command rides
 * the `child-session:` idempotency namespace (idx_commands_run + prefix match). */
async function gatewayChildRunIds(runIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await db
    .select({ runId: commands.runId })
    .from(commands)
    .where(
      and(
        inArray(commands.runId, [...runIds]),
        like(commands.idempotencyKey, `${CHILD_SESSION_IDEMPOTENCY_PREFIX}:%`),
      ),
    );
  return new Set(rows.map((r) => r.runId).filter((id): id is string => id !== null));
}

/** Attach steps to a set of run rows in a single batched query, preserving the
 * given run order. Shared by the list + thread readers. */
async function withSteps(runRows: RunRecord[]): Promise<ApiRun[]> {
  if (runRows.length === 0) return [];
  const runIds = runRows.map((r) => r.id);
  const [stepRows, uploadsByRun, childRuns] = await Promise.all([
    db.select().from(steps).where(inArray(steps.runId, runIds)).orderBy(steps.idx),
    listUploadsForRuns(runIds),
    gatewayChildRunIds(runIds),
  ]);

  const byRun = new Map<string, StepRecord[]>();
  for (const s of stepRows) {
    const list = byRun.get(s.runId) ?? [];
    list.push(s);
    byRun.set(s.runId, list);
  }
  return runRows.map((r) =>
    toRun(r, byRun.get(r.id) ?? [], uploadsByRun.get(r.id) ?? [], childRuns.has(r.id)),
  );
}

// ---------------------------------------------------------------------------
// Boot recovery
// ---------------------------------------------------------------------------

/** Honest fallback summary for a run we cannot reconcile after an unclean
 * shutdown: it lost its in-memory worker and the native session (if any) is
 * unreachable or unfinished, so the log stays truthful and points the user at
 * the recovery action — replying resumes the same thread/session. */
export const STALE_SUMMARY =
  "Interrupted - the backend restarted mid-run. Reply to continue in this thread.";

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
    repos: string[];
    resolvedResources?: readonly RunResource[];
    /** Team-memory pool for the run. Resolved server-side at the run-creation
     *  boundary (explicit choice, parent inheritance, or the "org" default). */
    memoryScope: MemoryScope;
    skillId?: string | null;
    skillVersion?: number | null;
    skillContentHash?: string | null;
    /** Validated native-command name (Phase 3); non-null => prompt delivered verbatim. */
    commandName?: string | null;
    /** The accepted command identity persisted with the run (fail-closed authorization). */
    commandProvider?: string | null;
    commandSessionId?: string | null;
    commandCatalogRevision?: number | null;
    /** Internal-run marker (src/runs/origin.ts); null for a real product run. */
    origin?: string | null;
  },
  /** Run the insert inside a caller's transaction (durable-command acceptance
   *  commits the command + run atomically). Defaults to the shared pool. */
  exec: Executor = db,
): Promise<void> {
  const primaryRepo = input.repos?.[0] ? parseRepoRef(input.repos[0]).repo : null;
  const project =
    input.orgId && primaryRepo
      ? await ensureProject(
          input.orgId,
          primaryRepo,
          { repoFullName: primaryRepo },
          exec,
        )
      : null;
  await exec.insert(runs).values({
    id: input.id,
    prompt: input.prompt,
    model: input.model,
    engine: input.engine,
    status: "queued",
    orgId: input.orgId,
    userId: input.userId,
    projectId: project?.id ?? null,
    parentRunId: input.parentRunId,
    threadId: input.threadId,
    repos: input.repos ?? [],
    resolvedResources: [...(input.resolvedResources ?? [])],
    // Legacy single-value mirror: clean "owner/name" (drop any branch suffix).
    repo: primaryRepo,
    memoryScope: input.memoryScope,
    skillId: input.skillId ?? null,
    skillVersion: input.skillVersion ?? null,
    skillContentHash: input.skillContentHash ?? null,
    commandName: input.commandName ?? null,
    commandProvider: input.commandProvider ?? null,
    commandSessionId: input.commandSessionId ?? null,
    commandCatalogRevision: input.commandCatalogRevision ?? null,
    origin: input.origin ?? null,
  });
}

export async function getRun(id: string): Promise<RunRecord | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row ?? null;
}

/** Persist the engine's own session id for a run (a peer tool's
 * set_resume_session_id model, durably) so the thread's next turn can resume the
 * engine's native conversation explicitly by id. */
export async function setRunEngineSession(
  id: string,
  sessionId: string,
  exec: Executor = db,
): Promise<void> {
  const updated = await exec
    .update(runs)
    .set({ engineSessionId: sessionId })
    .where(eq(runs.id, id))
    .returning({ id: runs.id });
  if (updated.length === 0) {
    throw new Error(`setRunEngineSession: run ${id} not found (no row updated)`);
  }
}

/** Persist the sandbox a run executed in (thread→sandbox mapping, durable). Returns
 * the updated row id; THROWS if no run row matched (a zero-row UPDATE must not read as
 * success - the control plane would then believe the association was recorded when it
 * was not). Callers await this BEFORE executing so a missing row fails the turn closed. */
export async function setRunSandbox(id: string, sandboxId: string): Promise<void> {
  const updated = await db
    .update(runs)
    .set({ sandboxId })
    .where(eq(runs.id, id))
    .returning({ id: runs.id });
  if (updated.length === 0) {
    throw new Error(`setRunSandbox: run ${id} not found (no row updated)`);
  }
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

export async function getThreadSandboxForOrg(
  orgId: string,
  threadId: string,
  exec: Executor = db,
): Promise<string | null> {
  const [row] = await exec
    .select({ sid: runs.sandboxId })
    .from(runs)
    .where(
      and(
        eq(runs.orgId, orgId),
        eq(runs.threadId, threadId),
        isNotNull(runs.sandboxId),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return row?.sid ?? null;
}

/** Whether a thread still has work that may be using its sandbox. */
export async function threadHasActiveRuns(
  orgId: string,
  threadId: string,
  exec: Executor = db,
): Promise<boolean> {
  const [row] = await exec
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.orgId, orgId),
        eq(runs.threadId, threadId),
        inArray(runs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Clear a thread's durable sandbox mapping after the provider confirms deletion.
 * The expected id prevents a delayed release from clearing a replacement box.
 */
export async function clearThreadSandbox(
  orgId: string,
  threadId: string,
  expectedSandboxId: string,
  exec: Executor = db,
): Promise<number> {
  const rows = await exec
    .update(runs)
    .set({ sandboxId: null, updatedAt: new Date() })
    .where(
      and(
        eq(runs.orgId, orgId),
        eq(runs.threadId, threadId),
        eq(runs.sandboxId, expectedSandboxId),
      ),
    )
    .returning({ id: runs.id });
  return rows.length;
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
  exec: Executor = db,
): Promise<RunRecord | null> {
  const [row] = await exec
    .select()
    .from(runs)
    .where(and(eq(runs.id, id), eq(runs.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/** Customer-facing lookup. Release canaries retain their authenticated direct
 * diagnostics, while autonomous model-qualification runs stay undiscoverable. */
export async function getCustomerRunForOrg(
  orgId: string,
  id: string,
  exec: Executor = db,
): Promise<RunRecord | null> {
  const [row] = await exec
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.id, id),
        eq(runs.orgId, orgId),
        or(isNull(runs.origin), ne(runs.origin, MODEL_QUALIFICATION_RUN_ORIGIN)),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getCustomerRunWithSteps(
  orgId: string,
  id: string,
): Promise<ApiRun | null> {
  const run = await getCustomerRunForOrg(orgId, id);
  if (!run) return null;
  const [stepRows, uploadsByRun, childRuns] = await Promise.all([
    db.select().from(steps).where(eq(steps.runId, id)).orderBy(steps.idx),
    listUploadsForRuns([id]),
    gatewayChildRunIds([id]),
  ]);
  return toRun(run, stepRows, uploadsByRun.get(id) ?? [], childRuns.has(id));
}

export async function getRunWithSteps(
  orgId: string,
  id: string,
): Promise<ApiRun | null> {
  const run = await getRunForOrg(orgId, id);
  if (!run) return null;
  const [stepRows, uploadsByRun, childRuns] = await Promise.all([
    db.select().from(steps).where(eq(steps.runId, id)).orderBy(steps.idx),
    listUploadsForRuns([id]),
    gatewayChildRunIds([id]),
  ]);
  return toRun(run, stepRows, uploadsByRun.get(id) ?? [], childRuns.has(id));
}

/** List runs for an org, newest first. By default only THREAD ROOTS (runs with
 * no parent) so the list shows one entry per conversation; `all` includes every
 * run in every thread. */
export async function listRunsWithSteps(
  orgId: string,
  opts: { all?: boolean; limit?: number } = {},
): Promise<ApiRun[]> {
  const publicRun = publicRunCondition();
  const where = opts.all
    ? and(eq(runs.orgId, orgId), publicRun)
    : and(eq(runs.orgId, orgId), isNull(runs.parentRunId), publicRun);
  const runRows = await db
    .select()
    .from(runs)
    .where(where)
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(opts.limit ?? 100);
  return withSteps(runRows);
}

/** Compact projection for navigation/dashboard surfaces. Heavy steps,
 * uploads, resources, and provider session state stay off this wire. */
export async function listRunSummaries(
  orgId: string,
  opts: { all?: boolean; limit?: number; includeActive?: boolean } = {},
): Promise<ApiRunSummary[]> {
  const limit = opts.limit ?? 100;
  const rootFilter = opts.all ? sql`` : sql`and root.parent_run_id is null`;
  const activeFilter = !opts.includeActive
    ? sql`false`
    : opts.all
      ? sql`status in ('queued', 'running')`
      : sql`latest_status in ('queued', 'running')`;
  const listOrder = opts.all
    ? sql`root.created_at desc, root.id desc`
    : sql`latest.updated_at desc, latest.created_at desc, latest.id desc,
        root.created_at desc, root.id desc`;
  const outputOrder = opts.all
    ? sql`created_at desc, id desc`
    : sql`latest_updated_at desc, latest_created_at desc, latest_run_id desc,
        created_at desc, id desc`;
  const rows = await db.execute(sql`
    with latest_thread_runs as (
      select
        candidate.id,
        candidate.org_id,
        candidate.thread_id,
        candidate.status,
        candidate.created_at,
        candidate.updated_at,
        row_number() over (
          partition by candidate.org_id, candidate.thread_id
          order by candidate.created_at desc, candidate.id desc
        ) as thread_rank
      from runs candidate
      where candidate.org_id = ${orgId}
        and candidate.origin is null
    ), summary_rows as (
      select
        root.id,
        root.prompt,
        root.model,
        root.engine,
        root.status,
        root.summary,
        root.duration_ms,
        root.project_id,
        root.repo,
        root.repos,
        root.created_at,
        root.updated_at,
        latest.id as latest_run_id,
        latest.status as latest_status,
        latest.created_at as latest_created_at,
        latest.updated_at as latest_updated_at,
        row_number() over (
          order by ${listOrder}
        ) as list_rank
      from runs root
      inner join latest_thread_runs latest
        on latest.org_id = root.org_id
        and latest.thread_id = root.thread_id
        and latest.thread_rank = 1
      where root.org_id = ${orgId}
        and root.origin is null
        ${rootFilter}
    ), bounded_rows as (
      select *
      from summary_rows
      where list_rank <= ${limit}
    ), active_rows as (
      select *
      from summary_rows
      where ${activeFilter}
      order by list_rank
      limit ${limit}
    ), selected_rows as (
      select * from bounded_rows
      union
      select * from active_rows
    )
    select
      id, prompt, model, engine, status, summary, duration_ms, project_id,
      repo, repos, created_at, updated_at,
      latest_run_id, latest_status, latest_created_at, latest_updated_at
    from selected_rows
    order by ${outputOrder}
  `);

  return rows.map((row) => {
    const repoRefs = row.repos as string[];
    const specs = repoRefs.map(parseRepoRef);
    return {
      id: row.id as string,
      prompt: row.prompt as string,
      model: row.model as string,
      engine: row.engine as EngineId,
      status: row.status as RunStatus,
      summary: row.summary as string | null,
      duration_ms: row.duration_ms as number | null,
      project_id: row.project_id as string | null,
      repo: row.repo ? parseRepoRef(row.repo as string).repo : null,
      repos: specs.map((spec) => spec.repo),
      repo_specs: specs,
      created_at: new Date(row.created_at as string | Date).toISOString(),
      updated_at: new Date(row.updated_at as string | Date).toISOString(),
      latest_run_id: row.latest_run_id as string,
      latest_status: row.latest_status as RunStatus,
      latest_created_at: new Date(row.latest_created_at as string | Date).toISOString(),
      latest_updated_at: new Date(row.latest_updated_at as string | Date).toISOString(),
    } satisfies ApiRunSummary;
  });
}

/** Every run in the thread that `id` belongs to, oldest→newest, with steps.
 * Org-scoped: a cross-org (or missing) id resolves to null (→ 404). */
export async function getThreadForRun(
  orgId: string,
  id: string,
): Promise<ApiRun[] | null> {
  const run = await getCustomerRunForOrg(orgId, id);
  if (!run) return null;
  const runRows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.threadId, run.threadId), eq(runs.orgId, orgId)))
    .orderBy(runs.createdAt, runs.id);
  return withSteps(runRows);
}

/** Per-turn SKELETON of the thread `id` belongs to, oldest→newest: run id,
 * status, step count, has-summary flag, created_at - no step bodies, no JSON
 * payloads (an index-friendly read: `idx_runs_org_thread_created` for the runs,
 * a correlated count over `idx_steps_run` per turn). Powers windowed initial
 * loading. Org-scoped exactly like getThreadForRun: a cross-org (or missing)
 * id resolves to null (→ 404). */
export async function getThreadOutlineForRun(
  orgId: string,
  id: string,
): Promise<ApiThreadOutlineTurn[] | null> {
  const run = await getCustomerRunForOrg(orgId, id);
  if (!run) return null;
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      hasSummary: sql<boolean>`${runs.summary} is not null`,
      // Explicitly table-qualified: drizzle renders interpolated columns
      // UNQUALIFIED inside sql`` fragments, and the inner scope would resolve
      // a bare "id" to steps.id (counting nothing).
      stepCount: sql<number>`(select count(*)::int from steps where steps.run_id = runs.id)`,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(and(eq(runs.threadId, run.threadId), eq(runs.orgId, orgId)))
    .orderBy(runs.createdAt, runs.id);
  return rows.map(
    (row) =>
      ({
        id: row.id,
        status: row.status,
        step_count: row.stepCount,
        has_summary: row.hasSummary,
        created_at: row.createdAt.toISOString(),
      }) satisfies ApiThreadOutlineTurn,
  );
}

/** The REQUESTED runs of the thread `id` belongs to, oldest→newest, with full
 * steps - the on-demand island fetch behind windowed initial loading. Reuses
 * the exact getThreadForRun serialization (one wire shape). Ids outside the
 * thread (or the org) are silently dropped, never leaked; a cross-org (or
 * missing) `id` resolves to null (→ 404). */
export async function getThreadRunsByIds(
  orgId: string,
  id: string,
  ids: readonly string[],
): Promise<ApiRun[] | null> {
  const run = await getCustomerRunForOrg(orgId, id);
  if (!run) return null;
  if (ids.length === 0) return [];
  const runRows = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.threadId, run.threadId),
        eq(runs.orgId, orgId),
        inArray(runs.id, [...ids]),
      ),
    )
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
  const [currentRun] = await db
    .select({ createdAt: runs.createdAt })
    .from(runs)
    .where(and(eq(runs.threadId, threadId), eq(runs.id, currentRunId)))
    .limit(1);
  const priorRun = currentRun
    ? or(
        lt(runs.createdAt, currentRun.createdAt),
        and(eq(runs.createdAt, currentRun.createdAt), lt(runs.id, currentRunId)),
      )
    : ne(runs.id, currentRunId);
  const rows = await db
    .select({ prompt: runs.prompt, summary: runs.summary })
    .from(runs)
    .where(
      and(
        eq(runs.threadId, threadId),
        priorRun,
        inArray(runs.status, ["completed", "failed"]),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(THREAD_MAX_TURNS);
  if (rows.length === 0) return "";

  // Keep the most recent turns, then trim oldest-first to the char budget.
  let blocks = rows
    .toReversed()
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
