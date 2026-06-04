import { sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { sandboxLeases } from "../db/schema";
import type { WorkloadTier } from "../db/schema/fleet";

// ---------------------------------------------------------------------------
// Sandbox lease persistence. A lease is a durable capacity RESERVATION: it holds
// declared cpu/memory against the host/provider budget while a run owns a
// sandbox. Normal settle releases it; crash recovery keeps it reserved until
// provider GC succeeds. The expiry claim reuses the shared outbox mechanics —
// `FOR UPDATE SKIP LOCKED` over due rows — so a future multi-worker deploy can
// reconcile leases concurrently without double-processing.
// ---------------------------------------------------------------------------

export interface NewLease {
  readonly runId: string;
  readonly threadId: string;
  readonly orgId: string;
  readonly provider: string;
  readonly tier: WorkloadTier;
  readonly cpuMillicores: number;
  readonly memoryMib: number;
  readonly leaseTtlMs: number;
  readonly sandboxId?: string | null;
}

/** Insert an ACTIVE lease reserving the run's declared resources. Returns the
 *  lease id. The partial unique index guarantees at most one capacity-holding lease per
 *  run, so a double-admit throws (caller treats it as already-leased). */
export async function createLease(
  lease: NewLease,
  exec: Executor = db,
): Promise<string> {
  const id = crypto.randomUUID();
  const expiry = new Date(Date.now() + lease.leaseTtlMs);
  await exec.insert(sandboxLeases).values({
    id,
    runId: lease.runId,
    threadId: lease.threadId,
    orgId: lease.orgId,
    provider: lease.provider,
    tier: lease.tier,
    reservedCpuMillicores: lease.cpuMillicores,
    reservedMemoryMib: lease.memoryMib,
    state: "active",
    sandboxId: lease.sandboxId ?? null,
    leaseExpiry: expiry,
  });
  return id;
}

/** Snapshot of currently-reserved capacity, including reclaiming leases and
 * retained thread sandboxes that no active lease currently owns. */
export interface ReservationSnapshot {
  readonly globalActiveSandboxes: number;
  readonly globalReservedCpuMillicores: number;
  readonly globalReservedMemoryMib: number;
  readonly orgActiveSandboxes: number;
}

const DEFAULT_RETAINED_SANDBOX_TTL_MIN = 4_320;

/**
 * A settled thread may reuse its sandbox until the provider's configured
 * auto-delete boundary. Historical run mappings older than that boundary are
 * no longer capacity reservations: providers may already have deleted them,
 * and the explicit release path clears them sooner when deletion is observed.
 */
export function retainedSandboxReservationTtlMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const minutes = Number(env.SANDBOX_AUTO_DELETE_MIN ?? DEFAULT_RETAINED_SANDBOX_TTL_MIN);
  return Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : DEFAULT_RETAINED_SANDBOX_TTL_MIN * 60_000;
}

export interface RetainedSandboxMapping {
  readonly orgId: string;
  readonly threadId: string;
  readonly sandboxId: string;
}

/**
 * Return the single current sandbox mapping for each thread. Older run rows are
 * immutable history, not additional resident sandboxes.
 */
export async function listCurrentRetainedSandboxMappings(
  exec: Executor = db,
): Promise<RetainedSandboxMapping[]> {
  const rows = await exec.execute(sql`
    select distinct on (org_id, thread_id)
      org_id, thread_id, sandbox_id
    from runs
    where sandbox_id is not null
    order by org_id, thread_id, created_at desc, id desc`);
  return rows.map((row) => ({
    orgId: String(row.org_id),
    threadId: String(row.thread_id),
    sandboxId: String(row.sandbox_id),
  }));
}

/**
 * Clear retained mappings that a successful authoritative provider listing did
 * not return. Callers must not invoke this after a failed or partial listing.
 */
export async function clearMissingRetainedSandboxMappings(
  liveSandboxIds: ReadonlySet<string>,
  exec: Executor = db,
): Promise<number> {
  const current = await listCurrentRetainedSandboxMappings(exec);
  const missing = [...new Set(
    current
      .map((mapping) => mapping.sandboxId)
      .filter((sandboxId) => !liveSandboxIds.has(sandboxId)),
  )];
  if (missing.length === 0) return 0;
  const rows = await exec.execute(sql`
    update runs
    set sandbox_id = null, updated_at = now()
    where sandbox_id in (${sql.join(missing.map((id) => sql`${id}`), sql`, `)})
    returning id`);
  return rows.length;
}

export async function reservationSnapshot(
  orgId: string,
  exec: Executor = db,
  excludeRetainedSandboxId?: string | null,
): Promise<ReservationSnapshot> {
  const retainedTtlMs = retainedSandboxReservationTtlMs();
  const retainedExclusion = excludeRetainedSandboxId
    ? sql`and candidate.sandbox_id <> ${excludeRetainedSandboxId}`
    : sql``;
  const [row] = await exec.execute(sql`
    with reserved as (
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
        ${retainedExclusion}
      order by candidate.sandbox_id
    )
    select
      ((select count(*) from reserved) + (select count(*) from retained))::int as global_count,
      ((select coalesce(sum(reserved_cpu_millicores), 0) from reserved) +
       (select coalesce(sum(cpu), 0) from retained))::int as global_cpu,
      ((select coalesce(sum(reserved_memory_mib), 0) from reserved) +
       (select coalesce(sum(mem), 0) from retained))::int as global_mem,
      ((select count(*) from reserved where org_id = ${orgId}) +
       (select count(*) from retained where org_id = ${orgId}))::int as org_count`);
  return {
    globalActiveSandboxes: Number(row?.global_count ?? 0),
    globalReservedCpuMillicores: Number(row?.global_cpu ?? 0),
    globalReservedMemoryMib: Number(row?.global_mem ?? 0),
    orgActiveSandboxes: Number(row?.org_count ?? 0),
  };
}

/** Release every active lease for a run (normal settle path). Reclaims capacity
 *  immediately. Idempotent. Returns the number of leases released. */
export async function releaseLeaseForRun(
  runId: string,
  exec: Executor = db,
): Promise<number> {
  const rows = await exec.execute(sql`
    update sandbox_leases set state = 'released', updated_at = now()
    where run_id = ${runId} and state = 'active'
    returning id`);
  return rows.length;
}

/** A claimed lease awaiting provider reconciliation. It continues to reserve
 * capacity until provider deletion is confirmed. */
export interface ReclaimingLease {
  readonly id: string;
  readonly runId: string;
  readonly threadId: string;
  readonly orgId: string;
  readonly provider: string;
  readonly sandboxId: string | null;
  readonly attemptCount: number;
}

/**
 * Claim due expired/retry leases without reclaiming their reserved capacity.
 * `liveRunIds` are excluded inside the same statement so a healthy local actor
 * cannot be fenced out by the heartbeat/claim race.
 */
export async function claimExpiredLeases(
  limit: number,
  liveRunIds: readonly string[] = [],
  exec: Executor = db,
): Promise<ReclaimingLease[]> {
  const liveFilter = liveRunIds.length === 0
    ? sql``
    : sql`and run_id not in (${sql.join(liveRunIds.map((id) => sql`${id}`), sql`, `)})`;
  const rows = await exec.execute(sql`
    update sandbox_leases set
      state = 'reclaiming',
      gc_attempt_count = gc_attempt_count + 1,
      next_gc_attempt_at = null,
      updated_at = now()
    where id in (
      select id from sandbox_leases
      where (
        (state = 'active' and lease_expiry < now()) or
        (state = 'reclaiming' and next_gc_attempt_at <= now())
      )
      ${liveFilter}
      order by coalesce(next_gc_attempt_at, lease_expiry) asc
      limit ${limit}
      for update skip locked
    )
    returning id, run_id, thread_id, org_id, provider, sandbox_id, gc_attempt_count`);
  return rows.map((r) => ({
    id: r.id as string,
    runId: r.run_id as string,
    threadId: r.thread_id as string,
    orgId: r.org_id as string,
    provider: r.provider as string,
    sandboxId: (r.sandbox_id as string | null) ?? null,
    attemptCount: Number(r.gc_attempt_count ?? 1),
  }));
}

export async function restoreLiveLease(
  leaseId: string,
  leaseTtlMs: number,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec.execute(sql`
    update sandbox_leases set
      state = 'active',
      heartbeat_at = now(),
      lease_expiry = now() + (${leaseTtlMs}::bigint * interval '1 millisecond'),
      next_gc_attempt_at = null,
      gc_last_error = null,
      updated_at = now()
    where id = ${leaseId} and state = 'reclaiming'
    returning id`);
  return rows.length > 0;
}

export async function scheduleLeaseGcRetry(
  leaseId: string,
  error: string,
  delayMs: number,
  exec: Executor = db,
): Promise<void> {
  await exec.execute(sql`
    update sandbox_leases set
      next_gc_attempt_at = now() + (${delayMs}::bigint * interval '1 millisecond'),
      gc_last_error = ${error.slice(0, 1000)},
      updated_at = now()
    where id = ${leaseId} and state = 'reclaiming'`);
}

export async function releaseReclaimedLease(
  leaseId: string,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec.execute(sql`
    update sandbox_leases set state = 'released', next_gc_attempt_at = null,
      gc_last_error = null, updated_at = now()
    where id = ${leaseId} and state = 'reclaiming'
    returning id`);
  return rows.length > 0;
}

/**
 * Heartbeat the leases of live runs: extend expiry by the TTL and backfill the
 * sandbox id/node from the run once its box exists. `liveRunIds` are the runs
 * whose actor is alive in THIS process (Stage A single-backend liveness). A lease
 * not heartbeaten stops being extended and eventually expires — the crash-reclaim
 * path. Returns the number of leases refreshed.
 */
export async function heartbeatLeases(
  liveRunIds: readonly string[],
  leaseTtlMs: number,
  exec: Executor = db,
): Promise<number> {
  if (liveRunIds.length === 0) return 0;
  const idList = sql.join(
    liveRunIds.map((id) => sql`${id}`),
    sql`, `,
  );
  // Compute the new expiry in SQL (now() + ttl) — a bound Date object does not
  // serialize through raw `sql` with postgres-js.
  const rows = await exec.execute(sql`
    update sandbox_leases l set
      heartbeat_at = now(),
      lease_expiry = now() + (${leaseTtlMs}::bigint * interval '1 millisecond'),
      sandbox_id = coalesce(l.sandbox_id, r.sandbox_id),
      updated_at = now()
    from runs r
    where l.run_id = r.id
      and l.state = 'active'
      and l.run_id in (${idList})
    returning l.id`);
  return rows.length;
}

/** Boot may safely release a reservation only when no provider sandbox was ever
 * observed. Real retained sandboxes keep their reservation until recovery or GC
 * proves they are gone. */
export async function releaseEmptyActiveLeasesOnBoot(
  exec: Executor = db,
): Promise<number> {
  const rows = await exec.execute(sql`
    update sandbox_leases set state = 'released', updated_at = now()
    where state = 'active' and sandbox_id is null
    returning id`);
  return rows.length;
}
