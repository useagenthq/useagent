import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { acceptRunCommand } from "../src/commands";
import { acceptRunCancel } from "../src/commands/cancel";
import { admitClaimedRun } from "../src/fleet/admission";
import {
  buildCapacityInventory,
  setProviderInventoryForTest,
} from "../src/fleet/inventory";
import {
  claimExpiredLeases,
  createLease,
  heartbeatLeases,
  reservationSnapshot,
} from "../src/fleet/lease-repo";
import {
  countOrgOpenAdmissions,
  getAdmission,
  listQueuedAdmissions,
  markAdmissionLeased,
  syncTerminalAdmissions,
} from "../src/fleet/admission-repo";
import {
  reconcileExpiredLease,
  reconcileFleetOnBoot,
  reconcileFleetOnce,
  startFleetReconciler,
  stopFleetReconciler,
} from "../src/fleet/reconciler";
import { pumpThread } from "../src/worker";
import { completeRun, getRun, setRunStatus } from "../src/runs/repo";
import { createOrgSession, json, uid, waitFor } from "./helpers";

// Fleet durable-admission integration tests (HA Stage A). Capacity-cap assertions
// drive the gate DIRECTLY (deterministic — no actor timing races); the durability
// + p50/p95 test exercises the full HTTP + worker path. Every test tunes limits
// via env (fleetCapacityConfig reads per call) and cleans up its own state.

// The wide limits the general suite runs under (preload.ts) — restored after each
// test that narrows them.
const PRELOAD_FLEET: Record<string, string | undefined> = {
  FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES: process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES,
  FLEET_ORG_MAX_ACTIVE_SANDBOXES: process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES,
  FLEET_ORG_MAX_QUEUE_DEPTH: process.env.FLEET_ORG_MAX_QUEUE_DEPTH,
};

const testOrgs = new Set<string>();
const track = (orgId: string): string => {
  testOrgs.add(orgId);
  return orgId;
};

function mockRun(id: string, threadId = id) {
  return {
    id,
    prompt: "task",
    model: "claude-opus-5",
    engine: "mock" as const,
    parentRunId: null,
    threadId,
    repos: [],
    memoryScope: "org" as const,
    skillId: null,
    skillVersion: null,
    skillContentHash: null,
    commandName: null,
    commandProvider: null,
    commandSessionId: null,
    commandCatalogRevision: null,
  };
}

async function accept(
  orgId: string,
  id = crypto.randomUUID(),
  threadId = id,
): Promise<string> {
  await acceptRunCommand({
    idempotencyKey: uid("k"),
    orgId,
    actorId: null,
    run: mockRun(id, threadId),
  });
  return id;
}

/** A `(v1, v2, ...)` SQL fragment for an `in (...)` clause (drizzle's `sql`
 *  template does not serialize a JS array for `= any(...)`). */
function inList(ids: readonly string[]) {
  return sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

afterEach(async () => {
  // Restore the wide suite limits + clear any injected provider inventory.
  for (const [k, v] of Object.entries(PRELOAD_FLEET)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setProviderInventoryForTest(null);
  // Settle + clear this test's durable state so global capacity resets and no
  // leftover queued command is pumped into the next test.
  const orgs = [...testOrgs];
  testOrgs.clear();
  for (const org of orgs) {
    await db.execute(sql`
      update runs set status = 'failed', settled_at = now(), updated_at = now()
      where org_id = ${org} and status in ('queued', 'running')`);
    await db.execute(sql`
      update commands set state = 'completed', updated_at = now()
      where org_id = ${org} and kind = 'run.create' and state in ('queued', 'dispatched')`);
    await db.execute(sql`delete from sandbox_leases where org_id = ${org}`);
    await db.execute(sql`delete from run_admissions where org_id = ${org}`);
    await db.execute(sql`update runs set sandbox_id = null where org_id = ${org}`);
  }
  // Never leave the background loop running into the next test/file — the drain
  // test starts it explicitly for its own body.
  stopFleetReconciler();
});

describe("durable admission — capacity enforcement", () => {
  test("20 submissions all durably accept; only the limit leases; the rest stay queued with a reason", async () => {
    stopFleetReconciler(); // drive admission manually — no background drain
    process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES = "3";
    process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES = "3";
    const orgId = track(`org-${uid("cap")}`);

    const runIds = await Promise.all(
      Array.from({ length: 20 }, () => accept(orgId)),
    );

    // 1. All 20 are DURABLY accepted (persisted as queued) — nothing dropped.
    expect(await countOrgOpenAdmissions(orgId)).toBe(20);

    // 2. Drive the gate for each (concurrently — the advisory lock serializes the
    //    decisions). Exactly the configured limit may lease.
    const decisions = await Promise.all(runIds.map((id) => admitClaimedRun(id)));
    expect(decisions.filter((d) => d.admit).length).toBe(3);

    // 3. Reservation reflects exactly the limit; never oversubscribed.
    expect((await reservationSnapshot(orgId)).globalActiveSandboxes).toBe(3);

    // 4. The rest remain queued WITH a reason.
    const admissions = await Promise.all(runIds.map((id) => getAdmission(id)));
    const queued = admissions.filter((a) => a?.state === "queued");
    expect(queued.length).toBe(17);
    expect(
      queued.every((a) => a?.queueReason === "global_limit" || a?.queueReason === "org_limit"),
    ).toBe(true);
  });

  test("a provider allocatable ceiling defers admission through the real gate", async () => {
    stopFleetReconciler();
    // Counts are generous so ONLY the provider ceiling can defer.
    process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES = "100";
    process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES = "100";
    // Provider reports less allocatable cpu than the 2000m standard request.
    setProviderInventoryForTest({
      readyNodes: 1,
      allocatableCpuMillicores: 500,
      allocatableMemoryMib: 64_000,
    });
    const orgId = track(`org-${uid("prov")}`);
    const runId = await accept(orgId);

    const decision = await admitClaimedRun(runId);
    expect(decision.admit).toBe(false);
    expect(decision.decision).toBe("queue_provider_capacity");
    expect((await getAdmission(runId))?.queueReason).toBe("provider_capacity");
  });

  test("one task's terminal failure leaves independent admission rows for every other task", async () => {
    stopFleetReconciler();
    const orgId = track(`org-${uid("indep")}`);
    const ids = await Promise.all(Array.from({ length: 5 }, () => accept(orgId)));

    // Fail exactly ONE task terminally (settle/QC failure) and sync its admission.
    await completeRun(ids[2]!, "failed", "boom", 0);
    await syncTerminalAdmissions();

    const admissions = await Promise.all(ids.map((id) => getAdmission(id)));
    for (let i = 0; i < ids.length; i++) {
      expect(admissions[i]).not.toBeNull();
      expect(admissions[i]?.state).toBe(i === 2 ? "failed" : "queued");
    }
    // The failure did not remove or disturb the other four rows.
    expect(await countOrgOpenAdmissions(orgId)).toBe(4);
  });
});

describe("durable admission — restart + crash recovery", () => {
  test("a restart while work is queued+active loses no task and reclaims capacity", async () => {
    stopFleetReconciler();
    process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES = "2";
    process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES = "2";
    const orgId = track(`org-${uid("restart")}`);

    const runIds = await Promise.all(Array.from({ length: 6 }, () => accept(orgId)));
    await Promise.all(runIds.map((id) => admitClaimedRun(id))); // 2 lease, 4 queue
    expect((await reservationSnapshot(orgId)).globalActiveSandboxes).toBe(2);
    expect(await countOrgOpenAdmissions(orgId)).toBe(6);

    // Simulate the backend restarting: re-run the boot reconciliation path.
    const boot = await reconcileFleetOnBoot();
    expect(boot.releasedLeases).toBe(2);

    // No task disappeared — all six admissions survive, none terminal.
    expect(await countOrgOpenAdmissions(orgId)).toBe(6);
    const admissions = await Promise.all(runIds.map((id) => getAdmission(id)));
    expect(admissions.every((a) => a?.state === "queued")).toBe(true);
    // Capacity reclaimed (the dead process's leases were released).
    expect((await reservationSnapshot(orgId)).globalActiveSandboxes).toBe(0);
  });

  test("heartbeat extends a live lease's expiry so a healthy long run keeps its slot", async () => {
    stopFleetReconciler();
    const orgId = track(`org-${uid("hb")}`);
    const runId = await accept(orgId);
    const leaseId = await createLease({
      runId,
      threadId: runId,
      orgId,
      provider: "mock",
      tier: "standard",
      cpuMillicores: 2_000,
      memoryMib: 8_192,
      leaseTtlMs: 1_000,
    });
    const readExpiry = async (): Promise<number> => {
      const [row] = await db.execute(
        sql`select lease_expiry from sandbox_leases where id = ${leaseId}`,
      );
      return new Date(row!.lease_expiry as string).getTime();
    };
    const before = await readExpiry();
    await new Promise((r) => setTimeout(r, 25));

    // Heartbeat the live run explicitly (bypasses the worker registry).
    expect(await heartbeatLeases([runId], 60_000)).toBe(1);

    expect(await readExpiry()).toBeGreaterThan(before);
  });

  test("expiry claim excludes live actors inside the durable claim", async () => {
    const orgId = track(`org-${uid("fence")}`);
    const runId = await accept(orgId);
    await createLease({
      runId,
      threadId: runId,
      orgId,
      provider: "mock",
      tier: "standard",
      cpuMillicores: 2_000,
      memoryMib: 8_192,
      leaseTtlMs: -1,
    });
    expect(await claimExpiredLeases(10, [runId])).toEqual([]);
    expect((await reservationSnapshot(orgId)).globalActiveSandboxes).toBe(1);
  });

  test("retained and warm sandboxes remain part of capacity", async () => {
    const orgId = track(`org-${uid("resident")}`);
    const runId = await accept(orgId);
    const leaseId = await createLease({
      runId,
      threadId: runId,
      orgId,
      provider: "mock",
      tier: "standard",
      cpuMillicores: 2_000,
      memoryMib: 8_192,
      leaseTtlMs: 10_000,
    });
    await db.execute(sql`update runs set sandbox_id = 'retained-box' where id = ${runId}`);
    await db.execute(sql`update sandbox_leases set sandbox_id = 'retained-box', state = 'released' where id = ${leaseId}`);
    setProviderInventoryForTest({ activeSandboxes: 1, warmPoolReady: 3 });
    const inventory = await buildCapacityInventory(orgId);
    expect(inventory.orgActiveSandboxes).toBe(1);
    expect(inventory.globalActiveSandboxes).toBe(3);
  });

  test("a follow-up reusing its thread sandbox does not double-count capacity", async () => {
    process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES = "1";
    process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES = "1";
    const orgId = track(`org-${uid("reuse")}`);
    const threadId = crypto.randomUUID();
    const firstRun = await accept(orgId, crypto.randomUUID(), threadId);
    const leaseId = await createLease({
      runId: firstRun,
      threadId,
      orgId,
      provider: "mock",
      tier: "standard",
      cpuMillicores: 2_000,
      memoryMib: 8_192,
      leaseTtlMs: 10_000,
      sandboxId: "shared-box",
    });
    await db.execute(sql`update runs set sandbox_id = 'shared-box', status = 'completed' where id = ${firstRun}`);
    await db.execute(sql`update sandbox_leases set state = 'released' where id = ${leaseId}`);
    setProviderInventoryForTest({ activeSandboxes: 1 });

    const followUp = await accept(orgId, crypto.randomUUID(), threadId);
    expect((await admitClaimedRun(followUp)).admit).toBe(true);
    expect((await reservationSnapshot(orgId)).globalActiveSandboxes).toBe(1);
  });

  test("a dead worker's lease expires and reconciles; capacity is reclaimed and the run settles", async () => {
    stopFleetReconciler();
    const orgId = track(`org-${uid("lease")}`);
    const runId = await accept(orgId);

    // The run went live, then its worker died mid-flight (no live actor, an
    // already-expired lease).
    await setRunStatus(runId, "running");
    const leaseId = await createLease({
      runId,
      threadId: runId,
      orgId,
      provider: "mock",
      tier: "standard",
      cpuMillicores: 2_000,
      memoryMib: 8_192,
      leaseTtlMs: -1_000, // already expired
    });
    await markAdmissionLeased(runId, leaseId);
    expect((await reservationSnapshot(orgId)).globalActiveSandboxes).toBe(1);

    const summary = await reconcileFleetOnce();
    expect(summary.expired).toBeGreaterThanOrEqual(1);

    // Capacity reclaimed and the orphaned run reached a terminal state.
    expect((await reservationSnapshot(orgId)).globalActiveSandboxes).toBe(0);
    expect((await getRun(runId))?.status).toBe("failed");
    expect((await getAdmission(runId))?.state).toBe("failed");
  });
});

describe("durable admission — cancellation + fan-out ceiling", () => {
  test("cancelling a queued run removes it without leaking a lease", async () => {
    stopFleetReconciler();
    process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES = "0"; // force every run to queue
    const orgId = track(`org-${uid("cancel")}`);
    const runId = await accept(orgId);

    await pumpThread(runId); // claims, gate defers (no capacity), requeues
    expect((await getAdmission(runId))?.state).toBe("queued");
    expect((await reservationSnapshot(orgId)).globalActiveSandboxes).toBe(0);

    const res = await acceptRunCancel({ orgId, actorId: null, runId });
    expect(res.status).toBe("accepted");

    expect((await getRun(runId))?.status).toBe("failed");
    expect((await getAdmission(runId))?.state).toBe("canceled");
    // No lease was created or leaked.
    expect((await reservationSnapshot(orgId)).globalActiveSandboxes).toBe(0);
  });

  test("the durable per-org queue ceiling returns 429 (server-side fan-out authority)", async () => {
    // Force everything to queue so the open-admission count climbs to the ceiling.
    process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES = "0";
    process.env.FLEET_ORG_MAX_QUEUE_DEPTH = "3";
    const session = await createOrgSession("fanout");
    track(session.orgId);

    for (let i = 0; i < 3; i++) {
      const r = await json("/api/runs", {
        method: "POST",
        body: { prompt: "queued task", engine: "mock" },
        cookies: session.cookies,
      });
      expect(r.status).toBe(201);
    }
    const over = await json<{ error: string }>("/api/runs", {
      method: "POST",
      body: { prompt: "over the ceiling", engine: "mock" },
      cookies: session.cookies,
    });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("fleet_queue_full");
  });

  test("concurrent accepts cannot race past the per-org queue ceiling", async () => {
    process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES = "0";
    process.env.FLEET_ORG_MAX_QUEUE_DEPTH = "3";
    const orgId = track(`org-${uid("atomic-ceiling")}`);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => accept(orgId)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(await countOrgOpenAdmissions(orgId)).toBe(3);
  });

  test("queued scans round-robin across orgs before taking a tenant's second item", async () => {
    const orgA = track(`org-${uid("fair-a")}`);
    const orgB = track(`org-${uid("fair-b")}`);
    await accept(orgA);
    await accept(orgA);
    await accept(orgB);
    const firstTwo = await listQueuedAdmissions(2);
    expect(new Set(firstTwo.map((item) => item.orgId))).toEqual(new Set([orgA, orgB]));
  });

  test("invalid resource requests fail terminally instead of queueing forever", async () => {
    const previous = process.env.FLEET_SANDBOX_CPU_MILLICORES;
    process.env.FLEET_SANDBOX_CPU_MILLICORES = "999999";
    const orgId = track(`org-${uid("invalid-resource")}`);
    const runId = await accept(orgId);
    await pumpThread(runId);
    expect((await getRun(runId))?.status).toBe("failed");
    expect((await getAdmission(runId))?.state).toBe("failed");
    if (previous === undefined) delete process.env.FLEET_SANDBOX_CPU_MILLICORES;
    else process.env.FLEET_SANDBOX_CPU_MILLICORES = previous;
  });

  test("provider GC failure keeps reclaiming capacity reserved and schedules retry", async () => {
    const orgId = track(`org-${uid("gc-retry")}`);
    const runId = await accept(orgId);
    const leaseId = await createLease({
      runId,
      threadId: runId,
      orgId,
      provider: "mock",
      tier: "standard",
      cpuMillicores: 2_000,
      memoryMib: 8_192,
      leaseTtlMs: -1,
    });
    await db.execute(sql`update sandbox_leases set sandbox_id = 'box-1' where id = ${leaseId}`);
    const [lease] = await claimExpiredLeases(1);
    await reconcileExpiredLease(lease!, async () => { throw new Error("provider down"); });
    expect((await reservationSnapshot(orgId)).globalActiveSandboxes).toBe(1);
    const [row] = await db.execute(sql`
      select state, next_gc_attempt_at, gc_last_error from sandbox_leases where id = ${leaseId}`);
    expect(row?.state).toBe("reclaiming");
    expect(row?.next_gc_attempt_at).not.toBeNull();
    expect(row?.gc_last_error).toBe("provider down");
  });

  test("confirmed provider GC clears the retained thread mapping before reclaiming capacity", async () => {
    const orgId = track(`org-${uid("gc-success")}`);
    const threadId = crypto.randomUUID();
    const runId = await accept(orgId, crypto.randomUUID(), threadId);
    const leaseId = await createLease({
      runId,
      threadId,
      orgId,
      provider: "mock",
      tier: "standard",
      cpuMillicores: 2_000,
      memoryMib: 8_192,
      leaseTtlMs: -1,
      sandboxId: "box-success",
    });
    await db.execute(sql`update runs set sandbox_id = 'box-success', status = 'running' where id = ${runId}`);
    await markAdmissionLeased(runId, leaseId);
    const [lease] = await claimExpiredLeases(1);
    await reconcileExpiredLease(lease!, async () => {});
    expect((await reservationSnapshot(orgId)).globalActiveSandboxes).toBe(0);
    expect((await getRun(runId))?.sandboxId).toBeNull();
  });
});

describe("durable admission — end-to-end drain + measured latency", () => {
  test("20 HTTP submissions all accept instantly and every task eventually completes", async () => {
    startFleetReconciler();
    process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES = "5";
    process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES = "5";
    const session = await createOrgSession("drain");
    track(session.orgId);
    const N = 20;

    const submissionMs: number[] = [];
    const ids: string[] = [];
    await Promise.all(
      Array.from({ length: N }, async () => {
        const t0 = Date.now();
        const r = await json<{ id: string }>("/api/runs", {
          method: "POST",
          body: { prompt: "drain task", engine: "mock" },
          cookies: session.cookies,
        });
        submissionMs.push(Date.now() - t0);
        expect(r.status).toBe(201);
        ids.push(r.body.id);
      }),
    );

    // Every submission is durably accepted (persisted), none dropped.
    expect(new Set(ids).size).toBe(N);
    expect(await countOrgOpenAdmissions(session.orgId)).toBeGreaterThan(0);

    // Every task eventually reaches a terminal state (queue + cascade + reconciler
    // drain it under the capacity cap).
    await waitFor(
      async () => {
        const [row] = await db.execute(sql`
          select count(*)::int as n from runs
          where id in ${inList(ids)} and status in ('completed', 'failed')`);
        return Number(row?.n) === N ? true : null;
      },
      { timeoutMs: 30_000, intervalMs: 100 },
    );

    // Real p50/p95 from durable timestamps.
    const rows = (await db.execute(sql`
      select r.created_at, r.settled_at, a.admitted_at
      from runs r join run_admissions a on a.run_id = r.id
      where r.id in ${inList(ids)}`)) as unknown as Array<{
      created_at: Date;
      settled_at: Date | null;
      admitted_at: Date | null;
    }>;
    const queueWaitMs = rows
      .filter((r) => r.admitted_at)
      .map((r) => new Date(r.admitted_at!).getTime() - new Date(r.created_at).getTime());
    const completionMs = rows
      .filter((r) => r.settled_at)
      .map((r) => new Date(r.settled_at!).getTime() - new Date(r.created_at).getTime());

    console.log(
      `[fleet p50/p95] n=${N} cap=5 | submission ms p50=${percentile(submissionMs, 50)} p95=${percentile(submissionMs, 95)} | ` +
        `queueWait ms p50=${percentile(queueWaitMs, 50)} p95=${percentile(queueWaitMs, 95)} | ` +
        `completion ms p50=${percentile(completionMs, 50)} p95=${percentile(completionMs, 95)}`,
    );

    // No capacity leaked once everything settled.
    await waitFor(
      async () =>
        (await reservationSnapshot(session.orgId)).globalActiveSandboxes === 0 ? true : null,
      { timeoutMs: 10_000, intervalMs: 100 },
    );
  }, 40_000);
});
