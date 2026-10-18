import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { acceptRunCommand } from "../src/commands";
import { CANCEL_SUMMARY } from "../src/commands/cancel";
import { db } from "../src/db/client";
import { reconcileQueue, runs } from "../src/db/schema";
import { acceptProductChildBatch } from "../src/runs/child-thread-batch-service";
import { enqueueReconcile } from "../src/runs/reconcile-queue";
import { markRunStarted } from "../src/runs/run-state";
import { stopRun } from "../src/runs/stop";
import { DEV_ORG_ID } from "../src/dev-org";
import { waitFor } from "./helpers"; // side-effect: imports src/index → migrate + seed

// Stop reaches everything the stopped turn delegated and nothing else:
// children and grandchildren still working are cancelled the durable way;
// siblings, parents and threads an earlier turn delegated are left alone.

const ORG = DEV_ORG_ID;

/** A queued run opening its own thread (root: runId === threadId), with the relationship the product records. */
async function enqueue(threadRelationship?: { parentThreadId: string; familyThreadId: string }): Promise<string> {
  const id = crypto.randomUUID();
  const out = await acceptRunCommand({
    idempotencyKey: null,
    orgId: ORG,
    actorId: null,
    run: { id, prompt: "x", model: "claude-opus-5", engine: "mock", parentRunId: null, threadId: id },
    ...(threadRelationship
      ? { threadRelationship: { ...threadRelationship, kind: "delegated" as const, title: "child", sourceRunId: threadRelationship.parentThreadId } }
      : {}),
  });
  expect(out.status).toBe("created");
  return id;
}

const root = () => enqueue();
/** A queued follow-up turn behind `after` in the same thread. */
async function followUp(threadId: string, after: string): Promise<string> {
  const id = crypto.randomUUID();
  const out = await acceptRunCommand({
    idempotencyKey: null,
    orgId: ORG,
    actorId: null,
    run: { id, prompt: "y", model: "claude-opus-5", engine: "mock", parentRunId: after, threadId },
  });
  expect(out.status).toBe("created");
  return id;
}
/** A queued run in a new thread the parent thread delegated to. */
const delegate = (parentThreadId: string, familyThreadId: string) => enqueue({ parentThreadId, familyThreadId });

async function record(runId: string): Promise<{ status: string; summary: string | null }> {
  const [row] = await db
    .select({ status: runs.status, summary: runs.summary })
    .from(runs)
    .where(and(eq(runs.orgId, ORG), eq(runs.id, runId)))
    .limit(1);
  return { status: row!.status, summary: row!.summary };
}

describe("stop reaches delegated threads", () => {
  test("stopping a run stops every live run below its thread, nearest first", async () => {
    const parent = await root();
    const child = await delegate(parent, parent);
    const grandchild = await delegate(child, parent);
    const sibling = await root();

    const outcome = await stopRun({ orgId: ORG, actorId: null, runId: parent });
    expect(outcome).toEqual({ status: "cancelling", replay: false, children: 2 });
    for (const id of [parent, child, grandchild]) {
      expect(await record(id)).toEqual({ status: "failed", summary: CANCEL_SUMMARY });
    }
    expect((await record(sibling)).status).toBe("queued");
  });

  test("a queued follow-up in a delegated thread is cancelled before that thread is pumped", async () => {
    const parent = await root();
    const child = await delegate(parent, parent);
    const next = await followUp(child, child);

    expect(await stopRun({ orgId: ORG, actorId: null, runId: parent })).toEqual({ status: "cancelling", replay: false, children: 2 });
    expect((await record(child)).status).toBe("failed");
    expect(await record(next)).toEqual({ status: "failed", summary: CANCEL_SUMMARY });
  });

  test("stopping a later turn leaves the threads an earlier turn delegated", async () => {
    const parent = await root();
    const child = await delegate(parent, parent);
    const later = await followUp(parent, parent);

    expect(await stopRun({ orgId: ORG, actorId: null, runId: later })).toEqual({ status: "cancelling", replay: false, children: 0 });
    expect((await record(child)).status).toBe("queued");
    expect((await record(parent)).status).toBe("queued");
  });

  test("a stopped turn cannot delegate afterwards, but a batch it created still replays", async () => {
    const parent = await root();
    const batch = {
      orgId: ORG,
      actorId: null,
      parentRunId: parent,
      parentThreadId: parent,
      children: [{ title: "child", prompt: "p", engine: null, model: null }],
    };
    const before = await acceptProductChildBatch({ ...batch, idempotencyKey: "before-stop" });
    expect(before.status).toBe("created");

    expect((await stopRun({ orgId: ORG, actorId: null, runId: parent })).status).toBe("cancelling");
    await expect(acceptProductChildBatch({ ...batch, idempotencyKey: "after-stop" })).rejects.toThrow("stopped");
    expect((await acceptProductChildBatch({ ...batch, idempotencyKey: "before-stop" })).status).toBe("replayed");
  });

  test("a run a Stop settled does not start when its worker arrives late", async () => {
    const parent = await root();
    await stopRun({ orgId: ORG, actorId: null, runId: parent });
    expect(await markRunStarted(parent)).toBe(false);
    expect((await record(parent)).status).toBe("failed");
    const other = await root();
    expect(await markRunStarted(other)).toBe(true);
  });

  test("Stop on a parked run with no live worker frees its thread for the next queued message", async () => {
    // After a restart a running run waits parked for its re-probe with no actor in
    // this process; Stop settles it in place and must settle its command too.
    const parked = await root();
    await db.execute(sql`update commands set state = 'dispatched' where run_id = ${parked} and kind = 'run.create'`);
    expect(await markRunStarted(parked)).toBe(true);
    await enqueueReconcile({ runId: parked, threadId: parked, sandboxId: "sb", sessionId: "ses", sinceAt: new Date(),
      nextAttemptAt: new Date(Date.now() + 60_000), deadline: new Date(Date.now() + 300_000) });
    const next = await followUp(parked, parked);

    expect(await stopRun({ orgId: ORG, actorId: null, runId: parked })).toMatchObject({ status: "cancelling" });

    expect(await record(parked)).toEqual({ status: "failed", summary: CANCEL_SUMMARY });
    expect(await db.select().from(reconcileQueue).where(eq(reconcileQueue.runId, parked))).toEqual([]);
    await waitFor(async () => ((await record(next)).status === "completed" ? true : null));
  });

  test("a repeated Stop replays without counting children twice", async () => {
    const parent = await root();
    await delegate(parent, parent);
    await stopRun({ orgId: ORG, actorId: null, runId: parent });
    expect(await stopRun({ orgId: ORG, actorId: null, runId: parent })).toEqual({
      status: "cancelling",
      replay: true,
      children: 0,
    });
  });

  test("stopping a child leaves its parent and siblings working", async () => {
    const parent = await root();
    const child = await delegate(parent, parent);
    const sibling = await delegate(parent, parent);

    const outcome = await stopRun({ orgId: ORG, actorId: null, runId: child });
    expect(outcome).toEqual({ status: "cancelling", replay: false, children: 0 });
    expect((await record(child)).status).toBe("failed");
    expect((await record(parent)).status).toBe("queued");
    expect((await record(sibling)).status).toBe("queued");
  });

  test("a settled run is reported as such and its delegated threads are left alone", async () => {
    const parent = await root();
    const child = await delegate(parent, parent);
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, parent));
    expect(await stopRun({ orgId: ORG, actorId: null, runId: parent })).toEqual({ status: "settled", runStatus: "completed" });
    expect((await record(child)).status).toBe("queued");
    expect(await stopRun({ orgId: ORG, actorId: null, runId: "missing" })).toEqual({ status: "not_found" });
  });
});
