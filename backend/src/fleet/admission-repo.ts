import { and, eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { runAdmissions } from "../db/schema";
import type {
  AdmissionState,
  QueueReason,
  RunAdmissionRow,
  WorkloadTier,
} from "../db/schema/fleet";
import { retainedSandboxReservationTtlMs } from "./lease-repo";

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

export interface CapacityAdmissionCursor {
  readonly priority: number;
  readonly queuedAt: string;
  readonly runId: string;
}

export type QueuedCapacityAdmission = NewRunAdmission & {
  readonly queueReason: QueueReason;
  readonly queuedAt: string;
  readonly globalActiveSandboxes: number;
  readonly globalReservedCpuMillicores: number;
  readonly globalReservedMemoryMib: number;
  readonly orgActiveSandboxes: number;
  readonly reclaimCandidate: {
    readonly runId: string;
    readonly orgId: string;
  } | null;
};

/** One keyset-paginated page of admissions held by any capacity gate, in the
 *  same priority/FIFO order used by admission. */
export async function listQueuedCapacityAdmissions(
  limit: number,
  after?: CapacityAdmissionCursor,
  exec: Executor = db,
): Promise<QueuedCapacityAdmission[]> {
  const retainedTtlMs = retainedSandboxReservationTtlMs();
  const afterFilter = after
    ? sql`and (
        priority < ${after.priority}
        or (priority = ${after.priority} and queued_at > ${after.queuedAt}::timestamptz)
        or (priority = ${after.priority} and queued_at = ${after.queuedAt}::timestamptz and run_id > ${after.runId})
      )`
    : sql``;
  const rows = await exec.execute(sql`
    with page as (
      select run_id, org_id, thread_id, engine, model, tier,
        cpu_millicores, memory_mib, priority, queue_reason, queued_at
      from run_admissions
      where state = 'queued'
        and queue_reason in ('provider_capacity', 'global_limit', 'org_limit')
        ${afterFilter}
      order by priority desc, queued_at asc, run_id asc
      limit ${limit}
    ), reserved as (
      select * from sandbox_leases where state in ('active', 'reclaiming')
    ), latest_thread_sandbox as (
      select distinct on (r.org_id, r.thread_id)
        r.sandbox_id, r.org_id, r.thread_id
      from runs r
      where r.sandbox_id is not null
        and (
          r.status in ('queued', 'running') or
          coalesce(r.settled_at, r.updated_at, r.created_at) >=
            now() - (${retainedTtlMs}::bigint * interval '1 millisecond')
        )
      order by r.org_id, r.thread_id, r.created_at desc, r.id desc
    ), retained as (
      select distinct on (candidate.sandbox_id)
        candidate.sandbox_id, candidate.org_id,
        coalesce(last_lease.reserved_cpu_millicores, 0) as cpu,
        coalesce(last_lease.reserved_memory_mib, 0) as mem
      from latest_thread_sandbox candidate
      left join lateral (
        select reserved_cpu_millicores, reserved_memory_mib
        from sandbox_leases h
        where h.sandbox_id = candidate.sandbox_id
        order by h.created_at desc
        limit 1
      ) last_lease on true
      where not exists (
        select 1 from reserved x where x.sandbox_id = candidate.sandbox_id
      )
      order by candidate.sandbox_id
    ), global_inventory as (
      select
        ((select count(*) from reserved) + (select count(*) from retained))::int as global_count,
        ((select coalesce(sum(reserved_cpu_millicores), 0) from reserved) +
         (select coalesce(sum(cpu), 0) from retained))::int as global_cpu,
        ((select coalesce(sum(reserved_memory_mib), 0) from reserved) +
         (select coalesce(sum(mem), 0) from retained))::int as global_mem
    ), org_inventory as (
      select org_id, count(*)::int as org_count
      from (
        select org_id from reserved
        union all
        select org_id from retained
      ) capacity
      group by org_id
    ), current_reclaimable as (
      select distinct on (r.org_id, r.thread_id)
        r.id, r.org_id, r.thread_id, r.sandbox_id, r.status,
        coalesce(r.settled_at, r.updated_at, r.created_at) as last_used_at
      from runs r
      where r.sandbox_id is not null
      order by r.org_id, r.thread_id, r.created_at desc, r.id desc
    ), reclaimable as (
      select c.*
      from current_reclaimable c
      where c.status in ('completed', 'failed')
        and not exists (
          select 1 from runs active
          where active.org_id = c.org_id
            and active.thread_id = c.thread_id
            and active.status in ('queued', 'running')
        )
        and not exists (
          select 1 from sandbox_leases lease
          where lease.sandbox_id = c.sandbox_id
            and lease.state in ('active', 'reclaiming')
        )
    ), global_candidate as (
      select id, org_id
      from reclaimable
      order by last_used_at asc, id asc
      limit 1
    ), org_candidates as (
      select distinct on (org_id) id, org_id
      from reclaimable
      order by org_id, last_used_at asc, id asc
    )
    select page.*,
      page.queued_at::text as queued_at_cursor,
      global_inventory.global_count,
      global_inventory.global_cpu,
      global_inventory.global_mem,
      coalesce(org_inventory.org_count, 0)::int as org_count,
      case when page.queue_reason = 'org_limit' then org_candidates.id else global_candidate.id end
        as candidate_run_id,
      case when page.queue_reason = 'org_limit' then org_candidates.org_id else global_candidate.org_id end
        as candidate_org_id
    from page
    cross join global_inventory
    left join org_inventory on org_inventory.org_id = page.org_id
    left join global_candidate on true
    left join org_candidates on org_candidates.org_id = page.org_id
    order by page.priority desc, page.queued_at asc, page.run_id asc`);
  return rows.map((row) => ({
    runId: String(row.run_id),
    orgId: String(row.org_id),
    threadId: String(row.thread_id),
    engine: String(row.engine),
    model: String(row.model),
    tier: row.tier as WorkloadTier,
    cpuMillicores: Number(row.cpu_millicores),
    memoryMib: Number(row.memory_mib),
    priority: Number(row.priority),
    queueReason: row.queue_reason as QueueReason,
    queuedAt: String(row.queued_at_cursor),
    globalActiveSandboxes: Number(row.global_count),
    globalReservedCpuMillicores: Number(row.global_cpu),
    globalReservedMemoryMib: Number(row.global_mem),
    orgActiveSandboxes: Number(row.org_count),
    reclaimCandidate: row.candidate_run_id && row.candidate_org_id
      ? { runId: String(row.candidate_run_id), orgId: String(row.candidate_org_id) }
      : null,
  }));
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
