import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { commands, runs } from "../src/db/schema";
import { acceptRunCommand } from "../src/commands";
import { acceptRunCancel, CANCEL_SUMMARY } from "../src/commands/cancel";
import { claimNextRun, listActiveCommands, settleCommandForRun } from "../src/commands/dispatch";
import { completeRun, setRunStatus } from "../src/runs/repo";
import { terminalOnReturn } from "../src/worker";
import "./helpers"; // side-effect: imports src/index → migrate + seed

// Durable cancellation (Fix: durable cancel). These exercise the command-layer
// invariants directly (no worker execution): a queued run fails atomically, a
// running run is left for its actor to settle, the `run.cancel` command is
// ALWAYS written terminal (so a SIGKILL can never strand it), and idempotency.

const ORG = "org-skynet-dev";

/** Enqueue a root run (run + run.create command, both queued). Root: runId === threadId. */
async function enqueueRoot(): Promise<string> {
  const id = crypto.randomUUID();
  const out = await acceptRunCommand({
    idempotencyKey: null,
    orgId: ORG,
    actorId: null,
    run: {
      id,
      prompt: "x",
      model: "claude-opus-5",
      engine: "mock",
      parentRunId: null,
      threadId: id,
    },
  });
  expect(out.status).toBe("created");
  return id;
}

async function cmdState(runId: string, kind: string): Promise<string | null> {
  const [row] = await db
    .select({ state: commands.state })
    .from(commands)
    .where(and(eq(commands.runId, runId), eq(commands.kind, kind)))
    .limit(1);
  return (row?.state as string) ?? null;
}

async function runStatus(runId: string): Promise<string | null> {
  const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1);
  return (row?.status as string) ?? null;
}

describe("durable run cancellation", () => {
  test("cancelling a QUEUED run fails it 'Stopped by user' and settles its command in one tx", async () => {
    const runId = await enqueueRoot();

    const out = await acceptRunCancel({ orgId: ORG, actorId: null, runId });
    expect(out.status).toBe("accepted");
    if (out.status === "accepted") expect(out.runStatusWas).toBe("queued");

    // Run failed honestly; its run.create command settled; run.cancel recorded.
    expect(await runStatus(runId)).toBe("failed");
    const [r] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(r.summary).toBe(CANCEL_SUMMARY);
    expect(await cmdState(runId, "run.create")).toBe("completed");
    expect(await cmdState(runId, "run.cancel")).toBe("completed");

    // A cancelled queued run can NEVER be dispatched (its command is completed),
    // so the boot reconciler / pump can't resurrect it.
    expect(await claimNextRun(runId)).toBeNull();
  });

  test("cancelling a RUNNING run records the intent but leaves the run for its actor", async () => {
    const runId = await enqueueRoot();
    expect(await claimNextRun(runId)).toBe(runId); // dispatched
    await setRunStatus(runId, "running");

    const out = await acceptRunCancel({ orgId: ORG, actorId: null, runId });
    expect(out.status).toBe("accepted");
    if (out.status === "accepted") expect(out.runStatusWas).toBe("running");

    // The tx does NOT fail a running run (its live actor stops it); only the
    // durable cancel intent is recorded (already terminal).
    expect(await runStatus(runId)).toBe("running");
    expect(await cmdState(runId, "run.cancel")).toBe("completed");
    expect(await cmdState(runId, "run.create")).toBe("dispatched");

    // retire so this run doesn't pollute a later boot reconcile in the suite.
    await db.execute(sql`update commands set state='completed' where run_id=${runId}`);
  });

  test("SIGKILL during cancel leaves NO stuck command (cancel intent is born terminal)", async () => {
    const runId = await enqueueRoot();
    expect(await claimNextRun(runId)).toBe(runId);
    await setRunStatus(runId, "running");

    // User cancels; the durable run.cancel commits. Then the process is SIGKILLed
    // BEFORE the in-memory actor abort/finalize runs — modelled by simply not
    // calling it. The cancel command must not be strandable.
    await acceptRunCancel({ orgId: ORG, actorId: null, runId });

    // INVARIANT: no run.cancel command anywhere is queued/dispatched — they are
    // written already-completed, so a crash at any instant cannot strand one.
    const stuckCancels = await db
      .select()
      .from(commands)
      .where(and(eq(commands.kind, "run.cancel"), sql`state in ('queued','dispatched')`));
    expect(stuckCancels).toHaveLength(0);

    // The still-`dispatched` run.create is a normal interrupted run — the EXISTING
    // recovery path resolves it (non-opencode running → failed + command settled).
    await completeRun(runId, "failed", CANCEL_SUMMARY, 0);
    expect((await settleCommandForRun(runId)).status).toBe("completed");

    // After recovery: this run has no queued/dispatched command left.
    const active = await listActiveCommands();
    expect(active.some((c) => c.runId === runId)).toBe(false);
    expect(await runStatus(runId)).toBe("failed");
  });

  test("cancel is idempotent: a repeated Stop is a no-op replay (one run.cancel row)", async () => {
    const runId = await enqueueRoot();
    expect(await claimNextRun(runId)).toBe(runId);
    await setRunStatus(runId, "running");

    const first = await acceptRunCancel({ orgId: ORG, actorId: null, runId });
    expect(first.status).toBe("accepted");
    const second = await acceptRunCancel({ orgId: ORG, actorId: null, runId });
    expect(second.status).toBe("already");

    const [{ n }] = await db.execute(
      sql`select count(*)::int as n from commands where run_id=${runId} and kind='run.cancel'`,
    );
    expect(n).toBe(1);

    await db.execute(sql`update commands set state='completed' where run_id=${runId}`);
  });

  test("cancelling an already-terminal run is a no-op (no cancel command written)", async () => {
    const runId = await enqueueRoot();
    await completeRun(runId, "completed", "done", 5);

    const out = await acceptRunCancel({ orgId: ORG, actorId: null, runId });
    expect(out.status).toBe("terminal");
    if (out.status === "terminal") expect(out.runStatus).toBe("completed");
    expect(await cmdState(runId, "run.cancel")).toBeNull();

    await db.execute(sql`update commands set state='completed' where run_id=${runId}`);
  });

  test("cancelling an unknown / cross-org run id is not_found", async () => {
    const out = await acceptRunCancel({ orgId: ORG, actorId: null, runId: crypto.randomUUID() });
    expect(out.status).toBe("not_found");
  });
});

// Blocker 2: durable cancellation DOMINATES a coincident provider completion in the
// worker's return path (an ACP agent that finishes the turn and returns normally after
// a user cancel). terminalOnReturn is the pure decision; the cancel-while-running (throw)
// path is the existing catch branch and is unchanged.
describe("cancel dominates provider completion (worker return path)", () => {
  test("adapter RETURNS but the run was cancelled → 'Stopped by user' (failed), not completed", () => {
    // race: user cancel accepted AND the provider reports a completion concurrently
    expect(terminalOnReturn(CANCEL_SUMMARY, "codex: ...done")).toEqual({ status: "failed", summary: CANCEL_SUMMARY });
  });
  test("adapter RETURNS with NO cancellation → the provider completion stands (real completion)", () => {
    expect(terminalOnReturn(null, "PONG")).toEqual({ status: "completed", summary: "PONG" });
  });
  test("completion with no adapter summary falls back to 'run completed'", () => {
    expect(terminalOnReturn(null, null)).toEqual({ status: "completed", summary: "run completed" });
  });
});
