import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { providerEvents } from "../src/db/schema";
import { acceptRunCommand } from "../src/commands";
import {
  recoverStaleRuns,
  runDueReconciles,
  RUN_RECONCILING,
  type ReconcileProbe,
} from "../src/runs/recovery";
import { enqueueReconcile, getReconcile } from "../src/runs/reconcile-queue";
import { getRun, insertStep, setRunEngineSession, setRunSandbox, setRunStatus, STALE_SUMMARY } from "../src/runs/repo";
import { uid } from "./helpers";

// The ADAPTIVE reconciler (#63): boot PARKS a transient run instead of honest-
// failing it, and a background loop re-probes within a budget. Covers park-on-
// boot (+ marker + thread stays reserved), reconcile-after-delay, fail-after-
// budget, no-double-adopt, and survives-own-restart.

const ORG = "org-skynet-dev";
const transientProbe: ReconcileProbe = async () => ({ status: "unreachable" });
const completedProbe: ReconcileProbe = async () => ({ status: "completed", summary: "adopted answer" });

/** Seed a running opencode run with a dispatched command + a step watermark. */
async function seedRunning(): Promise<{ runId: string; threadId: string }> {
  const id = uid("run");
  await acceptRunCommand({
    idempotencyKey: null,
    orgId: ORG,
    actorId: null,
    run: { id, prompt: "x", model: "claude-opus-5", engine: "opencode", parentRunId: null, threadId: id },
  });
  await setRunStatus(id, "running");
  await setRunEngineSession(id, "ses_x");
  await setRunSandbox(id, "sb_x");
  await db.execute(sql`update commands set state='dispatched' where run_id=${id} and kind='run.create'`);
  await insertStep({ runId: id, idx: 0, kind: "task", label: "Thinking…", chip: "opencode", code: null });
  return { runId: id, threadId: id };
}

async function park(runId: string, threadId: string, over: Partial<{ nextAttemptAt: Date; deadline: Date }> = {}) {
  await enqueueReconcile({
    runId,
    threadId,
    sandboxId: "sb_x",
    sessionId: "ses_x",
    sinceAt: new Date(0),
    nextAttemptAt: over.nextAttemptAt ?? new Date(Date.now() - 1_000),
    deadline: over.deadline ?? new Date(Date.now() + 300_000),
  });
}

async function reconcilingMarkers(runId: string) {
  for (let i = 0; i < 40; i++) {
    const rows = await db
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.runId, runId), eq(providerEvents.eventType, RUN_RECONCILING)));
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return [];
}

beforeEach(async () => {
  await db.execute(sql`delete from reconcile_queue`);
});
afterEach(async () => {
  await db.execute(sql`delete from reconcile_queue`);
});

describe("boot PARK instead of honest-fail (#63)", () => {
  test("a transient running opencode run is PARKED (still running), marked, thread reserved", async () => {
    const { runId } = await seedRunning();
    const res = await recoverStaleRuns(transientProbe);
    expect(res.parked).toBeGreaterThanOrEqual(1);
    expect((await getRun(runId))?.status).toBe("running"); // NOT failed
    expect(await getReconcile(runId)).not.toBeNull(); // parked durably
    expect((await reconcilingMarkers(runId)).length).toBe(1); // reconciling marker emitted
    // The command stays dispatched (thread reserved) so no reply dispatches over it.
    const [cmd] = (await db.execute(
      sql`select state from commands where run_id=${runId} and kind='run.create'`,
    )) as unknown as [{ state: string }];
    expect(cmd.state).toBe("dispatched");
  });
});

describe("background re-probe loop", () => {
  test("reconcile-after-delay: a finished session is ADOPTED", async () => {
    const { runId, threadId } = await seedRunning();
    await park(runId, threadId);
    const out = await runDueReconciles(completedProbe);
    expect(out.adopted).toBe(1);
    const run = await getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.summary).toBe("adopted answer");
    expect(await getReconcile(runId)).toBeNull(); // dequeued
  });

  test("fail-after-budget: past the deadline, honest-fail with the resumable summary", async () => {
    const { runId, threadId } = await seedRunning();
    await park(runId, threadId, { deadline: new Date(Date.now() - 1) }); // budget already spent
    const out = await runDueReconciles(transientProbe);
    expect(out.failed).toBe(1);
    const run = await getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.summary).toBe(STALE_SUMMARY);
    expect(await getReconcile(runId)).toBeNull();
  });

  test("retry before the deadline: reschedules, keeps the run running + parked", async () => {
    const { runId, threadId } = await seedRunning();
    await park(runId, threadId, { deadline: new Date(Date.now() + 300_000) });
    const out = await runDueReconciles(transientProbe);
    expect(out.retried).toBe(1);
    expect((await getRun(runId))?.status).toBe("running");
    const row = await getReconcile(runId);
    expect(row?.attempts).toBe(1);
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now()); // rescheduled forward
  });

  test("no-double-adopt: a run already settled by another lane is dropped, not re-finalized", async () => {
    const { runId, threadId } = await seedRunning();
    await park(runId, threadId);
    // Another lane settled it (e.g. a reply's worker / cancel) → completed with ITS summary.
    await setRunStatus(runId, "completed");
    const out = await runDueReconciles(completedProbe);
    expect(out.dropped).toBe(1);
    expect(out.adopted).toBe(0);
    expect(await getReconcile(runId)).toBeNull(); // parked row cleared
    expect((await getRun(runId))?.status).toBe("completed");
  });
});

describe("survives the reconciler's own restart", () => {
  test("re-running boot recovery re-parks idempotently, preserving the original deadline", async () => {
    const { runId } = await seedRunning();
    await recoverStaleRuns(transientProbe); // first boot → park
    const first = await getReconcile(runId);
    expect(first).not.toBeNull();
    const originalDeadline = first!.deadline.getTime();

    // Simulate a restart mid-window: boot recovery runs again over the same run.
    const res2 = await recoverStaleRuns(transientProbe);
    expect(res2.parked).toBeGreaterThanOrEqual(1);
    const second = await getReconcile(runId);
    expect(second!.deadline.getTime()).toBe(originalDeadline); // budget NOT extended
    expect((await getRun(runId))?.status).toBe("running"); // still parked, not failed
  });
});
