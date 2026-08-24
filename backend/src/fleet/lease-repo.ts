import { sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { sandboxLeases } from "../db/schema";
import type { WorkloadTier } from "../db/schema/fleet";

// ---------------------------------------------------------------------------
// Sandbox lease persistence. A lease is a durable capacity RESERVATION: it holds
// declared cpu/memory against the host/provider budget while a run owns a
// sandbox. Releasing (normal settle) or expiring (crashed worker) reclaims that
// capacity. The expiry claim reuses the shared outbox mechanics —
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
}

/** Insert an ACTIVE lease reserving the run's declared resources. Returns the
 *  lease id. The partial unique index guarantees at most one active lease per
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
    leaseExpiry: expiry,
  });
  return id;
}

/** Snapshot of currently-reserved capacity, for the policy. Global totals plus
 *  this org's active count, computed from ACTIVE leases in one round trip. */
export interface ReservationSnapshot {
  readonly globalActiveSandboxes: number;
  readonly globalReservedCpuMillicores: number;
  readonly globalReservedMemoryMib: number;
  readonly orgActiveSandboxes: number;
}

export async function reservationSnapshot(
  orgId: string,
  exec: Executor = db,
): Promise<ReservationSnapshot> {
  const [row] = await exec.execute(sql`
    select
      count(*)::int as global_count,
      coalesce(sum(reserved_cpu_millicores), 0)::int as global_cpu,
      coalesce(sum(reserved_memory_mib), 0)::int as global_mem,
      count(*) filter (where org_id = ${orgId})::int as org_count
    from sandbox_leases
    where state = 'active'`);
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

/** A claimed, expired lease awaiting provider reconciliation. */
export interface ExpiredLease {
  readonly id: string;
  readonly runId: string;
  readonly orgId: string;
  readonly provider: string;
  readonly sandboxId: string | null;
}

/**
 * Claim up to `limit` ACTIVE leases whose expiry has passed, flipping them to
 * `expired` in one transaction (`FOR UPDATE SKIP LOCKED`, the outbox idiom). The
 * capacity is reclaimed the moment they flip; the caller then reconciles each
 * against the provider (delete the orphaned sandbox) best-effort.
 */
export async function claimExpiredLeases(
  limit: number,
  exec: Executor = db,
): Promise<ExpiredLease[]> {
  const rows = await exec.execute(sql`
    update sandbox_leases set state = 'expired', updated_at = now()
    where id in (
      select id from sandbox_leases
      where state = 'active' and lease_expiry < now()
      order by lease_expiry asc
      limit ${limit}
      for update skip locked
    )
    returning id, run_id, org_id, provider, sandbox_id`);
  return rows.map((r) => ({
    id: r.id as string,
    runId: r.run_id as string,
    orgId: r.org_id as string,
    provider: r.provider as string,
    sandboxId: (r.sandbox_id as string | null) ?? null,
  }));
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

/** Boot reconciliation: the process that owned every active lease is gone, so
 *  release them all (capacity zeroed). Recovery then re-pumps threads and
 *  re-admission mints fresh leases. Returns the count released. */
export async function releaseAllActiveLeasesOnBoot(
  exec: Executor = db,
): Promise<number> {
  const rows = await exec.execute(sql`
    update sandbox_leases set state = 'released', updated_at = now()
    where state = 'active'
    returning id`);
  return rows.length;
}
