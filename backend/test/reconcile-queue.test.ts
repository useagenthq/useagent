import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import {
  bumpReconcile,
  claimDueReconciles,
  deleteReconcile,
  enqueueReconcile,
  getReconcile,
  nextReconcileAction,
  RECONCILE_CLAIM_LEASE_MS,
  reconcileBackoffAt,
} from "../src/runs/reconcile-queue";
import { uid } from "./helpers";

// The durable parked state + timing policy for the adaptive reconciler (#63).
// Pure policy is unit-tested; the repo is exercised against useAgent_test (importing
// ./helpers runs the boot migrator, so this also proves migration 0025 applies).

describe("reconcile timing policy (pure)", () => {
  test("backoff is 15s / 30s / 60s, then capped at 60s", () => {
    expect(reconcileBackoffAt(0, 0).getTime()).toBe(15_000);
    expect(reconcileBackoffAt(0, 1).getTime()).toBe(30_000);
    expect(reconcileBackoffAt(0, 2).getTime()).toBe(60_000);
    expect(reconcileBackoffAt(0, 3).getTime()).toBe(60_000);
    expect(reconcileBackoffAt(1_000, 0).getTime()).toBe(16_000);
  });

  test("completed -> adopt regardless of the deadline", () => {
    expect(nextReconcileAction(true, 0, 100)).toBe("adopt");
    expect(nextReconcileAction(true, 999, 100)).toBe("adopt");
  });

  test("transient -> retry before the deadline, fail at/after it", () => {
    expect(nextReconcileAction(false, 50, 100)).toBe("retry");
    expect(nextReconcileAction(false, 100, 100)).toBe("fail");
    expect(nextReconcileAction(false, 200, 100)).toBe("fail");
  });
});

function parkInput(runId: string, over: Partial<{ nextAttemptAt: Date; deadline: Date }> = {}) {
  return {
    runId,
    threadId: runId,
    sandboxId: "sb-1",
    sessionId: "ses-1",
    sinceAt: new Date(1_000),
    nextAttemptAt: over.nextAttemptAt ?? new Date(Date.now() - 1_000),
    deadline: over.deadline ?? new Date(Date.now() + 300_000),
  };
}

beforeEach(async () => {
  await db.execute(sql`delete from reconcile_queue`);
});

describe("reconcile queue repo", () => {
  test("enqueue is idempotent per run and preserves the original deadline", async () => {
    const runId = uid("run");
    const firstDeadline = new Date(Date.now() + 300_000);
    expect(await enqueueReconcile(parkInput(runId, { deadline: firstDeadline }))).toBe(true);
    // A re-park (e.g. reconciler restart re-runs boot recovery) does NOT extend the budget.
    expect(await enqueueReconcile(parkInput(runId, { deadline: new Date(Date.now() + 999_000) }))).toBe(false);
    const row = await getReconcile(runId);
    expect(row?.deadline.getTime()).toBe(firstDeadline.getTime());
  });

  test("claimDue returns due rows only (future next_attempt_at is skipped)", async () => {
    const due = uid("run");
    const notYet = uid("run");
    await enqueueReconcile(parkInput(due, { nextAttemptAt: new Date(Date.now() - 5_000) }));
    await enqueueReconcile(parkInput(notYet, { nextAttemptAt: new Date(Date.now() + 60_000) }));
    const claimed = await claimDueReconciles();
    const ids = claimed.map((c) => c.runId);
    expect(ids).toContain(due);
    expect(ids).not.toContain(notYet);
    // Mapped shape carries the reconcile inputs.
    const c = claimed.find((x) => x.runId === due)!;
    expect(c.sinceMs).toBe(1_000);
    expect(c.sandboxId).toBe("sb-1");
  });

  test("bump advances attempts + reschedules; delete removes the row", async () => {
    const runId = uid("run");
    await enqueueReconcile(parkInput(runId));
    await bumpReconcile(runId, new Date(Date.now() + 60_000));
    const row = await getReconcile(runId);
    expect(row?.attempts).toBe(1);
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // No longer due (rescheduled into the future).
    expect((await claimDueReconciles()).map((c) => c.runId)).not.toContain(runId);
    await deleteReconcile(runId);
    expect(await getReconcile(runId)).toBeNull();
  });
});

describe("claims are leased and never shared", () => {
  test("a claimed row is invisible to a second claim until its lease expires, and a lease is not an attempt", async () => {
    const runId = uid("run");
    await enqueueReconcile(parkInput(runId));
    expect((await claimDueReconciles(20, 60_000)).map((c) => c.runId)).toContain(runId);
    expect((await claimDueReconciles(20, 60_000)).map((c) => c.runId)).not.toContain(runId);
    expect((await getReconcile(runId))?.attempts).toBe(0);
    // The tick that held the lease died: expiry re-exposes the row.
    await db.execute(sql`update reconcile_queue set next_attempt_at = now() - interval '1 second' where run_id = ${runId}`);
    expect((await claimDueReconciles(20, 60_000)).map((c) => c.runId)).toContain(runId);
  });

  test("the configured lease is about 60 s and the claim returns the exact lease it wrote", async () => {
    const runId = uid("run");
    await enqueueReconcile(parkInput(runId));
    const [c] = await claimDueReconciles(1);
    const ms = c!.leaseUntil.getTime() - Date.now();
    expect(ms).toBeGreaterThan(55_000);
    expect(ms).toBeLessThanOrEqual(RECONCILE_CLAIM_LEASE_MS + 1_000); // the monotonic floor adds at most a few ms
    expect((await getReconcile(runId))!.nextAttemptAt.getTime()).toBe(c!.leaseUntil.getTime());
  });

  test("a tick that outlived its lease cannot bump or delete the row its replacement claimed", async () => {
    const runId = uid("run");
    await enqueueReconcile(parkInput(runId));
    const [a] = await claimDueReconciles(1, 50); // A holds a 50 ms lease
    await new Promise((r) => setTimeout(r, 80)); // and stalls past it
    const [b] = await claimDueReconciles(1); // B re-claims the same row
    expect(b?.runId).toBe(runId);
    expect(b!.leaseUntil.getTime()).not.toBe(a!.leaseUntil.getTime());
    // A resumes: every write it makes is fenced on the lease it held.
    expect(await bumpReconcile(runId, new Date(Date.now() + 15_000), a!.leaseUntil)).toBe(false);
    expect(await deleteReconcile(runId, a!.leaseUntil)).toBe(false);
    let row = await getReconcile(runId);
    expect(row?.attempts).toBe(0);
    expect(row!.nextAttemptAt.getTime()).toBe(b!.leaseUntil.getTime()); // B's lease untouched
    // B's writes go through.
    expect(await bumpReconcile(runId, new Date(Date.now() + 15_000), b!.leaseUntil)).toBe(true);
    row = await getReconcile(runId);
    expect(row?.attempts).toBe(1);
  });

  test("a fenced delete inside a transaction that rolls back leaves the row parked", async () => {
    const runId = uid("run");
    await enqueueReconcile(parkInput(runId));
    const [c] = await claimDueReconciles(1);
    await expect(db.transaction(async (tx) => {
      expect(await deleteReconcile(runId, c!.leaseUntil, tx)).toBe(true);
      throw new Error("finalization aborted");
    })).rejects.toThrow("finalization aborted");
    expect(await getReconcile(runId)).not.toBeNull();
  });

  test("two claims running at once split the due rows instead of sharing them", async () => {
    const ids = Array.from({ length: 6 }, () => uid("run"));
    for (const id of ids) await enqueueReconcile(parkInput(id));
    const [a, b] = await Promise.all([claimDueReconciles(3), claimDueReconciles(3)]);
    const seen = [...a, ...b].map((c) => c.runId);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.toSorted()).toEqual(ids.toSorted());
  });
});
