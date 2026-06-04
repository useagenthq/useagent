import { and, eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { runAdmissions } from "../db/schema";
import type {
  AdmissionState,
  QueueReason,
  RunAdmissionRow,
  WorkloadTier,
} from "../db/schema/fleet";

// ---------------------------------------------------------------------------
// Run-admission persistence. One row per accepted run records the requested
// resource class + the capacity lifecycle state. Inserted ATOMICALLY with the
// run + command (commands/repo.ts) so a queued task is as durable as the run
// itself. All transitions are guarded UPDATEs — idempotent and restart-safe.
// ---------------------------------------------------------------------------

const OPEN_STATES = ["queued", "leased", "running"] as const;

export interface NewRunAdmission {
  readonly runId: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly engine: string;
  readonly model: string;
  readonly tier: WorkloadTier;
  readonly cpuMillicores: number;
  readonly memoryMib: number;
  readonly priority: number;
}

/** Insert the admission row for a freshly accepted run (state `queued`). */
export async function insertRunAdmission(
  input: NewRunAdmission,
  exec: Executor = db,
): Promise<void> {
  await exec.insert(runAdmissions).values({
    runId: input.runId,
    orgId: input.orgId,
    threadId: input.threadId,
    engine: input.engine,
    model: input.model,
    tier: input.tier,
    cpuMillicores: input.cpuMillicores,
    memoryMib: input.memoryMib,
    priority: input.priority,
    state: "queued",
  });
}

export async function getAdmission(
  runId: string,
  exec: Executor = db,
): Promise<RunAdmissionRow | null> {
  const [row] = await exec
    .select()
    .from(runAdmissions)
    .where(eq(runAdmissions.runId, runId))
    .limit(1);
  return row ?? null;
}

/** Count an org's non-terminal admissions — the durable queue-depth ceiling
 *  input (the server-side fan-out authority). */
export async function countOrgOpenAdmissions(
  orgId: string,
  exec: Executor = db,
): Promise<number> {
  const [row] = await exec.execute(sql`
    select count(*)::int as n from run_admissions
    where org_id = ${orgId} and state in ('queued', 'leased', 'running')`);
  return Number(row?.n ?? 0);
}

/** Count an org's still-queued (not yet admitted) admissions — for usage UI. */
export async function countOrgQueuedAdmissions(
  orgId: string,
  exec: Executor = db,
): Promise<number> {
  const [row] = await exec.execute(sql`
    select count(*)::int as n from run_admissions
    where org_id = ${orgId} and state = 'queued'`);
  return Number(row?.n ?? 0);
}

export async function oldestQueuedAdmissionForReason(
  reason: QueueReason,
  exec: Executor = db,
): Promise<NewRunAdmission | null> {
  const [row] = await exec.execute(sql`
    select run_id, org_id, thread_id, engine, model, tier,
      cpu_millicores, memory_mib, priority
    from run_admissions
    where state = 'queued' and queue_reason = ${reason}
    order by priority desc, queued_at asc, run_id asc
    limit 1`);
  if (!row) return null;
  return {
    runId: String(row.run_id),
    orgId: String(row.org_id),
    threadId: String(row.thread_id),
    engine: String(row.engine),
    model: String(row.model),
    tier: row.tier as WorkloadTier,
    cpuMillicores: Number(row.cpu_millicores),
    memoryMib: Number(row.memory_mib),
    priority: Number(row.priority),
  };
}

/** Grant capacity: bind the lease and move to `leased`, clearing queue_reason. */
export async function markAdmissionLeased(
  runId: string,
  leaseId: string,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(runAdmissions)
    .set({
      state: "leased",
      workerLeaseId: leaseId,
      queueReason: null,
      admittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(runAdmissions.runId, runId));
}

/** Keep a run queued and record WHY. `bumpRetry` is set when re-queuing after a
 *  lost lease (never for a first capacity deferral, which has not run yet). */
export async function markAdmissionQueued(
  runId: string,
  reason: QueueReason,
  opts: { readonly bumpRetry?: boolean } = {},
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(runAdmissions)
    .set({
      state: "queued",
      queueReason: reason,
      workerLeaseId: null,
      retryCount: opts.bumpRetry
        ? sql`${runAdmissions.retryCount} + 1`
        : runAdmissions.retryCount,
      updatedAt: new Date(),
    })
    .where(eq(runAdmissions.runId, runId));
}

/** Sync the admission to a run lifecycle state (running / terminal). Terminal
 *  states stamp settled_at. Idempotent. */
export async function setAdmissionState(
  runId: string,
  state: AdmissionState,
  exec: Executor = db,
): Promise<void> {
  const terminal = state === "completed" || state === "failed" || state === "canceled";
  await exec
    .update(runAdmissions)
    .set({
      state,
      updatedAt: new Date(),
      ...(terminal ? { settledAt: new Date() } : {}),
    })
    .where(eq(runAdmissions.runId, runId));
}

/** A queued admission awaiting capacity — the reconciler's admit work list. */
export interface QueuedAdmission {
  readonly runId: string;
  readonly threadId: string;
  readonly orgId: string;
  readonly priority: number;
}

/** Fair queued-admission scan: one item per org before any org's second item,
 * while preserving priority/age within each tenant. */
export async function listQueuedAdmissions(
  limit: number,
  exec: Executor = db,
): Promise<QueuedAdmission[]> {
  const rows = await exec.execute(sql`
    with fair as (
      select run_id, thread_id, org_id, priority, queued_at,
        row_number() over (
          partition by org_id order by priority desc, queued_at asc, run_id asc
        ) as org_rank
      from run_admissions
      where state = 'queued'
    )
    select run_id, thread_id, org_id, priority
    from fair
    order by org_rank asc, priority desc, queued_at asc, org_id asc
    limit ${limit}`);
  return rows.map((row) => ({
    runId: row.run_id as string,
    threadId: row.thread_id as string,
    orgId: row.org_id as string,
    priority: Number(row.priority),
  }));
}

/** Boot reconciliation: unbind admissions whose lease died with the process
 *  (non-terminal runs) so re-admission mints a fresh lease. Returns the count. */
export async function resetLeasedAdmissionsForBoot(
  exec: Executor = db,
): Promise<number> {
  const rows = await exec.execute(sql`
    update run_admissions a set
      state = 'queued', worker_lease_id = null, queue_reason = null, updated_at = now()
    from runs r, sandbox_leases l
    where a.run_id = r.id
      and a.worker_lease_id = l.id
      and l.state = 'released'
      and l.sandbox_id is null
      and a.state in ('leased', 'running')
      and r.status in ('queued', 'running')
    returning a.run_id`);
  return rows.length;
}

/** Mirror the run going live: leased admissions whose run is `running` advance
 *  to `running` (cosmetic — capacity is driven by the lease, not this state).
 *  Returns the count advanced. */
export async function syncRunningAdmissions(exec: Executor = db): Promise<number> {
  const rows = await exec.execute(sql`
    update run_admissions a set state = 'running', updated_at = now()
    from runs r
    where a.run_id = r.id and r.status = 'running' and a.state = 'leased'
    returning a.run_id`);
  return rows.length;
}

/** Sync admissions of already-terminal runs (settled out of band, e.g. adopted
 *  by boot recovery) to the run's terminal state. Returns the count synced. */
export async function syncTerminalAdmissions(exec: Executor = db): Promise<number> {
  const rows = await exec.execute(sql`
    update run_admissions a set
      state = r.status, settled_at = coalesce(a.settled_at, now()), updated_at = now()
    from runs r
    where a.run_id = r.id
      and r.status in ('completed', 'failed')
      and a.state in ('queued', 'leased', 'running')
    returning a.run_id`);
  return rows.length;
}

/** Approximate queue position: how many queued runs rank ahead of this one
 *  (higher priority, or same priority and older). 1-based; 0 once admitted. */
export async function queuePosition(
  runId: string,
  exec: Executor = db,
): Promise<number> {
  const [row] = await exec.execute(sql`
    with me as (
      select priority, queued_at, state from run_admissions where run_id = ${runId}
    )
    select case when (select state from me) <> 'queued' then 0 else (
      select count(*)::int + 1 from run_admissions a, me
      where a.state = 'queued'
        and (a.priority > me.priority
          or (a.priority = me.priority and a.queued_at < me.queued_at))
    ) end as pos`);
  return Number(row?.pos ?? 0);
}

export { OPEN_STATES };
