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
  reconcileBackoffAt,
} from "../src/runs/reconcile-queue";
import { uid } from "./helpers";

// The durable parked state + timing policy for the adaptive reconciler (#63).
// Pure policy is unit-tested; the repo is exercised against skynet_test (importing
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
