import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { acceptRunCommand } from "../src/commands";
import { acceptRunCancel, CANCEL_SUMMARY } from "../src/commands/cancel";
import { recoverStaleRuns, type ReconcileProbe } from "../src/runs/recovery";
import {
  createRun,
  getRun,
  insertStep,
  setRunEngineSession,
  setRunSandbox,
  setRunStatus,
  STALE_SUMMARY,
} from "../src/runs/repo";
import type { EngineId, RunStatus } from "../src/db/schema";
import { waitFor } from "./helpers"; // side-effect: imports src/index → migrate + seed

// Boot recovery of the durable command lane, driven with a deterministic fake
// harness probe. Covers the crash matrix: reconcile an in-flight run, free a
// thread whose command was stuck (crash before settle), requeue a run whose
// worker never started, re-dispatch the queued next turn IN ORDER, and fail
// legacy runs with no command.

const ORG = "org-skynet-dev";

/** A finished opencode session reports its answer; anything else is unreachable. */
const fakeReconcile: ReconcileProbe = async (handle) =>
  handle.sessionId === "ses_done"
    ? { status: "completed", summary: "the real answer" }
    : { status: "unreachable" };

/** Seed a command+run and force it into a specific (run, command) state. */
async function seed(opts: {
  runId?: string;
  threadId: string;
  parentRunId: string | null;
  engine: EngineId;
  runStatus: RunStatus;
  commandState: "queued" | "dispatched";
  session?: string;
  sandbox?: string;
  withStep?: boolean;
}): Promise<string> {
  const id = opts.runId ?? crypto.randomUUID();
  await acceptRunCommand({
    idempotencyKey: null,
    orgId: ORG,
    actorId: null,
    run: { id, prompt: "x", model: "claude-opus-5", engine: opts.engine, parentRunId: opts.parentRunId, threadId: opts.threadId },
  });
  if (opts.runStatus !== "queued") await setRunStatus(id, opts.runStatus);
  if (opts.session) await setRunEngineSession(id, opts.session);
  if (opts.sandbox) await setRunSandbox(id, opts.sandbox);
  await db.execute(sql`update commands set state=${opts.commandState} where run_id=${id} and kind='run.create'`);
  if (opts.withStep) {
    await insertStep({ runId: id, idx: 0, kind: "task", label: "Thinking…", chip: "opencode", code: null });
  }
  return id;
}

const isDone = async (id: string) => ((await getRun(id))?.status === "completed" ? true : null);

describe("command-lane restart recovery", () => {
  test("a durable cancel settles the interrupted run and unblocks its queued replacement", async () => {
    const A = crypto.randomUUID();
    await seed({
      runId: A,
      threadId: A,
      parentRunId: null,
      engine: "opencode",
      runStatus: "running",
      commandState: "dispatched",
      session: "ses_done",
      sandbox: "sb",
      withStep: true,
    });
    const B = await seed({
      threadId: A,
      parentRunId: A,
      engine: "mock",
      runStatus: "queued",
      commandState: "queued",
    });
    await acceptRunCancel({ orgId: ORG, actorId: null, runId: A });

    await recoverStaleRuns(fakeReconcile);

    expect((await getRun(A))?.status).toBe("failed");
    expect((await getRun(A))?.summary).toBe(CANCEL_SUMMARY);
    await waitFor(() => isDone(B));
  });

  test("reconciles the in-flight run AND dispatches the queued next turn in order", async () => {
    // A: opencode, running, command dispatched (native session finished server-side).
    const A = crypto.randomUUID();
    await seed({ runId: A, threadId: A, parentRunId: null, engine: "opencode", runStatus: "running", commandState: "dispatched", session: "ses_done", sandbox: "sb", withStep: true });
    // B: mock reply, queued behind A.
    const B = await seed({ threadId: A, parentRunId: A, engine: "mock", runStatus: "queued", commandState: "queued" });

    const res = await recoverStaleRuns(fakeReconcile);

    // A reconciled to completed with the real answer.
    const runA = await getRun(A);
    expect(runA?.status).toBe("completed");
    expect(runA?.summary).toBe("the real answer");
    expect(res.reconciled).toBeGreaterThanOrEqual(1);

    // B re-dispatched → executes (mock) → completes. (Order: only after A settled.)
    await waitFor(() => isDone(B));
  });

  test("frees a thread whose command was stuck 'dispatched' after the run already finished", async () => {
    // Crash between A completing and its command settling: run completed, command dispatched.
    const A = crypto.randomUUID();
    await seed({ runId: A, threadId: A, parentRunId: null, engine: "mock", runStatus: "completed", commandState: "dispatched" });
    const B = await seed({ threadId: A, parentRunId: A, engine: "mock", runStatus: "queued", commandState: "queued" });

    await recoverStaleRuns(fakeReconcile);

    // B still runs — the stuck command is settled so the thread frees for B.
    await waitFor(() => isDone(B));
  });

  test("requeues + re-dispatches a run whose worker died before it started", async () => {
    // Crash between dispatch-commit and run→running: command dispatched, run queued.
    const A = crypto.randomUUID();
    await seed({ runId: A, threadId: A, parentRunId: null, engine: "mock", runStatus: "queued", commandState: "dispatched" });
    await recoverStaleRuns(fakeReconcile);
    await waitFor(() => isDone(A));
  });

  test("fails a legacy non-terminal run that has no command", async () => {
    const legacy = crypto.randomUUID();
    await createRun({ id: legacy, prompt: "x", model: "claude-opus-5", engine: "mock", orgId: ORG, userId: null, parentRunId: null, threadId: legacy });
    await setRunStatus(legacy, "running");

    const res = await recoverStaleRuns(fakeReconcile);

    expect((await getRun(legacy))?.status).toBe("failed");
    expect((await getRun(legacy))?.summary).toBe(STALE_SUMMARY);
    expect((await getRun(legacy))?.settledAt).toBeInstanceOf(Date);
    expect(res.failed).toBeGreaterThanOrEqual(1);
  });
});
