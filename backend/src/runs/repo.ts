import type {
  ApiRun,
  ApiRunLifecycle,
  ApiRunSummary,
  ApiStep,
  ApiThreadOutlineTurn,
  PermissionMode,
  RunLocation,
} from "@useagent/agent-client/wire";
import {
  configuredRuntimeMode,
  PermissionModeUnsupportedError,
  permissionModeSupported,
} from "../engines/permission-mode";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
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
import type { SandboxProviderKind } from "@useagent/sandbox-contract";
import { getCustomerRunForOrg } from "./run-state";
export { completeRun, getCustomerRunForOrg, pinSkillToActiveRun, setRunStatus } from "./run-state";
export {
  getThreadEngineSession,
  getThreadProviderSessionState,
  setRunEngineSession,
  setRunProviderSession,
  type ThreadProviderSessionState,
} from "./provider-session-repo";

// The run/step API shapes are the agent-client WIRE CONTRACT (single source of
// truth; packages never import apps). Re-exported so the many backend modules that
// read them from `../runs/repo` keep one import path; the serializers below
// `satisfies` them, so any field or optionality drift is a compile error here.
export type { ApiRun, ApiRunLifecycle, ApiRunSummary, ApiStep, ApiThreadOutlineTurn };

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
    reasoning_effort: r.reasoningEffort,
    engine: r.engine,
    status: r.status,
    summary: r.summary,
    duration_ms: r.durationMs,
    parent_run_id: r.parentRunId,
    child_session: childSession,
    thread_id: r.threadId,
    thread_seq: r.threadSeq,
    engine_session_id: r.engineSessionId,
    sandbox_id: r.sandboxId,
    sandbox_provider: r.sandboxProvider ?? null,
    repo: r.repo ? parseRepoRef(r.repo).repo : null,
    repos: specs.map((s) => s.repo),
    repo_specs: specs,
    resolved_resources: r.resolvedResources ?? [],
    memory_scope: r.memoryScope,
    permission_mode: r.permissionMode,
    run_location: r.runLocation ?? null,
    skill_id: r.skillId,
    skill_version: r.skillVersion,
    skill_content_hash: r.skillContentHash,
    uploads,
    connector: r.connector ?? null,
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

/** Runs with a committed durable cancel intent. */
async function cancelledRunIds(runIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await db
    .select({ runId: commands.runId })
    .from(commands)
    .where(and(inArray(commands.runId, [...runIds]), eq(commands.kind, "run.cancel")));
  return new Set(rows.map((row) => row.runId).filter((id): id is string => id !== null));
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
    /** Resolved at the run-creation boundary (see runs/reasoning-effort.ts). */
    reasoningEffort?: string | null;
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
    /** The run's permission policy. Product lanes resolve it (composer choice or
     *  the parent's); a lane that omits it takes the operator's configured posture. */
    permissionMode?: PermissionMode;
    /** Where the thread runs (RunLocation); null: the cloud, or a caller that predates the choice. */ runLocation?: RunLocation | null;
    skillId?: string | null;
    skillVersion?: number | null;
    skillContentHash?: string | null;
    /** Validated native-command name (Phase 3); non-null => prompt delivered verbatim. */
    commandName?: string | null;
    /** The accepted command identity persisted with the run (fail-closed authorization). */
    commandProvider?: string | null;
    commandSessionId?: string | null;
    commandCatalogRevision?: number | null;
    expectedSandbox?: RunRecord["expectedSandbox"];
    /** Internal-run marker (src/runs/origin.ts); null for a real product run. */
    origin?: string | null;
  },
  /** Run the insert inside a caller's transaction (durable-command acceptance
   *  commits the command + run atomically). Defaults to the shared pool. */
  exec: Executor = db,
): Promise<void> {
  // The one place every lane inserts a run: a mode the engine cannot honour
  // never reaches the row, whoever asked for it (a child of a read-only turn
  // spawned on Pi, a bot handoff to a Pi bot).
  const permissionMode = input.permissionMode ?? configuredRuntimeMode();
  if (permissionMode !== "full-access" && !permissionModeSupported(input.engine)) {
    throw new PermissionModeUnsupportedError(input.engine, permissionMode);
  }
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
    reasoningEffort: input.reasoningEffort ?? null,
    engine: input.engine,
    status: "queued",
    // The insert's own clock time, not the transaction's start (`now()`): the
    // acceptance transaction opens before it takes the thread lifecycle lock, so
    // a run that waited for the lock must still sort after every run accepted
    // while it waited. Thread order is the order runs were accepted in.
    createdAt: sql`clock_timestamp()`,
    // The run's place in its thread, assigned here under the same lock: the
    // lossless acceptance order the wire carries (created_at loses its
    // microseconds in transit).
    threadSeq: sql`(select coalesce(max(${runs.threadSeq}), 0) + 1 from ${runs} where ${runs.threadId} = ${input.threadId})`,
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
    permissionMode,
    runLocation: input.runLocation ?? null,
    skillId: input.skillId ?? null,
    skillVersion: input.skillVersion ?? null,
    skillContentHash: input.skillContentHash ?? null,
    commandName: input.commandName ?? null,
    commandProvider: input.commandProvider ?? null,
    commandSessionId: input.commandSessionId ?? null,
    commandCatalogRevision: input.commandCatalogRevision ?? null,
    expectedSandbox: input.expectedSandbox ?? null,
    origin: input.origin ?? null,
  });
}

export async function getRun(id: string): Promise<RunRecord | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row ?? null;
}

/** The thread's newest run: the turn whose mode a follow-up without a choice
 *  keeps. Newest by acceptance order: `created_at` is the insert's clock time
 *  taken under the thread lifecycle lock (see createRun), so a run that waited
 *  for the lock sorts after the runs accepted meanwhile. Read it through the
 *  acceptance transaction when the answer decides what the inserted run may do. */
export async function getLatestThreadRun(
  orgId: string,
  threadId: string,
  exec: Executor = db,
): Promise<RunRecord | null> {
  const [row] = await exec
    .select()
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.threadId, threadId)))
    .orderBy(desc(runs.threadSeq), desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return row ?? null;
}

/** Persist the sandbox a run executed in (thread→sandbox mapping, durable). Returns
 * the updated row id; THROWS if no run row matched (a zero-row UPDATE must not read as
 * success - the control plane would then believe the association was recorded when it
 * was not). Callers await this BEFORE executing so a missing row fails the turn closed. */
export async function setRunSandbox(
  id: string,
  sandboxId: string,
  binding?: { readonly kind: SandboxProviderKind; readonly credential: "env" | "user" },
): Promise<void> {
  const updated = await db
    .update(runs)
    .set({
      sandboxId,
      ...(binding ? { sandboxProvider: binding.kind, sandboxCredential: binding.credential } : {}),
    })
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
    .set({
      sandboxId: null,
      engineSessionId: null,
      providerSession: null,
      updatedAt: new Date(),
    })
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

export async function getCustomerRunLifecycle(
  orgId: string,
  id: string,
): Promise<ApiRunLifecycle | null> {
  const run = await getCustomerRunForOrg(orgId, id);
  if (!run) return null;
  return {
    id: run.id,
    thread_id: run.threadId,
    status: run.status,
    cancelled: (await cancelledRunIds([id])).has(id),
  };
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
    .orderBy(runs.threadSeq, runs.createdAt, runs.id);
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
    .orderBy(runs.threadSeq, runs.createdAt, runs.id);
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
    .orderBy(runs.threadSeq, runs.createdAt, runs.id);
  return withSteps(runRows);
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

/** Append a step after the run's last one, for a lane without the worker's
 *  in-memory step counter (the restart recovery loop). */
export async function appendStep(
  runId: string,
  step: { kind: StepKind; label: string; chip: string | null; code: unknown | null },
): Promise<ApiStep> {
  const [last] = await db
    .select({ idx: sql<number>`coalesce(max(${steps.idx}), -1)` })
    .from(steps)
    .where(eq(steps.runId, runId));
  return insertStep({ runId, idx: (last?.idx ?? -1) + 1, ...step });
}
