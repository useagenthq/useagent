import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { providerEvents } from "../src/db/schema";
import { acceptRunCommand } from "../src/commands";
import { settleCommandForRun } from "../src/commands/dispatch";
import { acceptRunCancel, CANCEL_SUMMARY } from "../src/commands/cancel";
import {
  INCOMPATIBLE_PROVIDER_SESSION_SUMMARY,
  recoverStaleRuns,
  runDueReconciles,
  type ReconcileProbe,
} from "../src/runs/recovery";
import { finalizeRun } from "../src/runs/finalize";
import { recordProviderEvent } from "../src/runs/provider-events";
import {
  createRun,
  getRun,
  insertStep,
  setRunEngineSession,
  setRunProviderSession,
  setRunSandbox,
  setRunStatus,
  STALE_SUMMARY,
} from "../src/runs/repo";
import { providerSessionBinding } from "@useagent/agent-harness/canonical";
import { providerProtocolIdentity } from "@useagent/agent-harness/control";
import { t3ProviderDrivers } from "../src/engines/t3-provider-driver";
import { piProviderDriver } from "../src/engines/pi-provider-driver";
import type { EngineId, RunStatus } from "../src/db/schema";
import { waitFor } from "./helpers"; // side-effect: imports src/index → migrate + seed
import { enqueueReconcile } from "../src/runs/reconcile-queue";

// Boot recovery of the durable command lane, driven with a deterministic fake
// harness probe. Covers the crash matrix: reconcile an in-flight run, free a
// thread whose command was stuck (crash before settle), requeue a run whose
// worker never started, re-dispatch the queued next turn IN ORDER, and fail
// legacy runs with no command.

const ORG = "org-skynet-dev";
const priorEnabledEngines = process.env.ENABLED_ENGINES;
const priorPiReadiness = process.env.ENGINE_READINESS_PI;
process.env.ENABLED_ENGINES = `${process.env.ENABLED_ENGINES ?? ""},pi`;
process.env.ENGINE_READINESS_PI = "verified";

afterAll(() => {
  if (priorEnabledEngines === undefined) delete process.env.ENABLED_ENGINES;
  else process.env.ENABLED_ENGINES = priorEnabledEngines;
  if (priorPiReadiness === undefined) delete process.env.ENGINE_READINESS_PI;
  else process.env.ENGINE_READINESS_PI = priorPiReadiness;
});

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
    run: {
      id,
      prompt: "x",
      model: opts.engine === "codex"
        ? "gpt-5.6-luna"
        : opts.engine === "pi" ? "openai/gpt-5.6-luna" : "claude-opus-5",
      engine: opts.engine,
      parentRunId: opts.parentRunId,
      threadId: opts.threadId,
    },
  });
  if (opts.runStatus !== "queued") await setRunStatus(id, opts.runStatus);
  if (opts.session && opts.sandbox) {
    const driver = opts.engine === "pi" ? piProviderDriver : null;
    await setRunSandbox(id, opts.sandbox);
    await setRunProviderSession(id, providerSessionBinding({
      provider: opts.engine === "daytona" ? "opencode" : opts.engine,
      nativeSessionId: opts.session,
      protocolVersion: driver
        ? providerProtocolIdentity(driver.descriptor.protocol)
        : opts.engine === "opencode" ? "opencode-server/compat" : "t3-orchestration",
      runtime: { kind: "sandbox", id: opts.sandbox },
      capabilities: driver?.descriptor.capabilities ?? ({} as never),
      generation: (driver?.descriptor.sessionGeneration as number | undefined) ?? 1,
    }));
  } else if (opts.session) await setRunEngineSession(id, opts.session);
  if (opts.sandbox && !opts.session) await setRunSandbox(id, opts.sandbox);
  await db.execute(sql`update commands set state=${opts.commandState} where run_id=${id} and kind='run.create'`);
  if (opts.withStep) {
    await insertStep({ runId: id, idx: 0, kind: "task", label: "Thinking…", chip: "opencode", code: null });
  }
  return id;
}

const isDone = async (id: string) => ((await getRun(id))?.status === "completed" ? true : null);

describe("command-lane restart recovery", () => {
  test("cleans an interrupted Pi writer before probing and finalizing", async () => {
    const runId = crypto.randomUUID();
    await seed({
      runId,
      threadId: runId,
      parentRunId: null,
      engine: "pi",
      runStatus: "running",
      commandState: "dispatched",
      session: "/sessions/pi.jsonl",
      sandbox: "pi-sandbox",
    });
    const order: string[] = [];

    await recoverStaleRuns(
      async () => {
        order.push("probe");
        return { status: "failed", summary: "backend restarted" };
      },
      async ({ sandboxId }) => {
        order.push(`cleanup:${sandboxId}`);
      },
    );

    expect(order).toEqual(["cleanup:pi-sandbox", "probe"]);
    expect((await getRun(runId))?.status).toBe("failed");
  });

  test("a failed Pi restart cleanup keeps the run and command fenced", async () => {
    const runId = crypto.randomUUID();
    await seed({
      runId,
      threadId: runId,
      parentRunId: null,
      engine: "pi",
      runStatus: "running",
      commandState: "dispatched",
      session: "/sessions/pi.jsonl",
      sandbox: "pi-sandbox",
    });
    let probed = false;

    await expect(recoverStaleRuns(
      async () => {
        probed = true;
        return { status: "failed", summary: "must not finalize" };
      },
      async () => {
        throw new Error("remote delete failed");
      },
    )).rejects.toThrow("remote delete failed");

    expect(probed).toBe(false);
    expect((await getRun(runId))?.status).toBe("running");
    const [command] = (await db.execute(
      sql`select state from commands where run_id=${runId} and kind='run.create'`,
    )) as unknown as [{ state: string }];
    expect(command.state).toBe("dispatched");
    await finalizeRun(runId, "failed", "test cleanup", 0);
    await settleCommandForRun(runId);
  });

  test("a failed Pi background cleanup cannot expire and free the interrupted run", async () => {
    const runId = crypto.randomUUID();
    await seed({
      runId,
      threadId: runId,
      parentRunId: null,
      engine: "pi",
      runStatus: "running",
      commandState: "dispatched",
      session: "/sessions/pi.jsonl",
      sandbox: "pi-sandbox",
    });
    await enqueueReconcile({
      runId,
      threadId: runId,
      sandboxId: "pi-sandbox",
      sessionId: "/sessions/pi.jsonl",
      sinceAt: new Date(0),
      nextAttemptAt: new Date(Date.now() - 1_000),
      deadline: new Date(Date.now() - 1),
    });
    let probed = false;

    const result = await runDueReconciles(
      async () => {
        probed = true;
        return { status: "completed", summary: "must not adopt" };
      },
      async () => {
        throw new Error("remote delete failed");
      },
    );

    expect(probed).toBe(false);
    expect(result.failed).toBe(0);
    expect((await getRun(runId))?.status).toBe("running");
    await finalizeRun(runId, "failed", "test cleanup", 0);
    await settleCommandForRun(runId);
  });

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

  test("persists recovered terminal activity before finalizing the run", async () => {
    const runId = crypto.randomUUID();
    await seed({
      runId,
      threadId: runId,
      parentRunId: null,
      engine: "opencode",
      runStatus: "running",
      commandState: "dispatched",
      session: "ses_terminal_tail",
      sandbox: "sb",
      withStep: true,
    });
    const result = await recoverStaleRuns(async (_handle, checkpoint) => {
      if (checkpoint.eventContext?.runId !== runId) return { status: "unreachable" };
      return {
        status: "completed",
        summary: "answer with durable tail",
        events: [{
          id: `pe_${runId}_t3_child-terminal`,
          runScopedId: true,
          provider: "t3",
          eventType: "t3.activity.task.completed",
          sessionId: "child-session",
          parentSessionId: "parent-session",
          partId: "child-terminal",
          callId: "child-session",
          payload: { status: "completed" },
        }],
      };
    });

    expect(result.reconciled).toBeGreaterThanOrEqual(1);
    const run = await getRun(runId);
    expect(run?.status).toBe("completed");
    const [event] = await db
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.runId, runId), eq(providerEvents.nativePartId, "child-terminal")));
    expect(event?.id).toBe(`pe_${runId}_t3_child-terminal`);
    expect(event?.nativeParentSessionId).toBe("parent-session");
    expect(event?.createdAt.getTime()).toBeLessThanOrEqual(run!.settledAt!.getTime());
  });

  test("persists recovered failure activity before finalizing with its reason", async () => {
    const runId = crypto.randomUUID();
    await seed({
      runId,
      threadId: runId,
      parentRunId: null,
      engine: "opencode",
      runStatus: "running",
      commandState: "dispatched",
      session: "ses_failed_tail",
      sandbox: "sb",
      withStep: true,
    });
    const eventId = `pe_${runId}_t3_failed-tail`;
    const result = await recoverStaleRuns(async (_handle, checkpoint) =>
      checkpoint.eventContext?.runId === runId
        ? {
            status: "failed",
            summary: "Provider turn interrupted",
            events: [{
              id: eventId,
              runScopedId: true,
              provider: "t3",
              eventType: "t3.activity.runtime.warning",
              partId: "failed-tail",
            }],
          }
        : { status: "unreachable" }
    );

    expect(result.failed).toBeGreaterThanOrEqual(1);
    const run = await getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.summary).toBe("Provider turn interrupted");
    const [event] = await db.select().from(providerEvents).where(eq(providerEvents.id, eventId));
    expect(event?.createdAt.getTime()).toBeLessThanOrEqual(run!.settledAt!.getTime());
  });

  test("parks when a required completed-event update fails despite an older row", async () => {
    const runId = crypto.randomUUID();
    await seed({
      runId,
      threadId: runId,
      parentRunId: null,
      engine: "opencode",
      runStatus: "running",
      commandState: "dispatched",
      session: "ses_terminal_retry",
      sandbox: "sb",
      withStep: true,
    });
    const eventId = `pe_${runId}_t3_stable-tool`;
    await recordProviderEvent({
      id: eventId,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.started",
      nativePartId: "stable-tool",
    }, { required: true });

    const result = await recoverStaleRuns(async (_handle, checkpoint) =>
      checkpoint.eventContext?.runId === runId
        ? {
            status: "completed",
            summary: "must wait for the tail",
            events: [{
              id: eventId,
              runScopedId: true,
              provider: "t3",
              eventType: null as never,
              partId: "stable-tool",
            }],
          }
        : { status: "unreachable" }
    );

    expect(result.parked).toBeGreaterThanOrEqual(1);
    expect((await getRun(runId))?.status).toBe("running");
    const [event] = await db.select().from(providerEvents).where(eq(providerEvents.id, eventId));
    expect(event?.eventType).toBe("t3.activity.tool.started");
  });

  test("a recovery finalizer loser reports the durable first-writer status", async () => {
    const runId = crypto.randomUUID();
    await seed({
      runId,
      threadId: runId,
      parentRunId: null,
      engine: "opencode",
      runStatus: "running",
      commandState: "dispatched",
      session: "ses_race",
      sandbox: "sb",
      withStep: true,
    });
    let releaseProbe!: () => void;
    let reportProbe!: () => void;
    const release = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const probing = new Promise<void>((resolve) => { reportProbe = resolve; });
    const recovery = recoverStaleRuns(async () => {
      reportProbe();
      await release;
      return { status: "completed", summary: "late provider completion" };
    });
    await probing;
    await finalizeRun(runId, "failed", "first writer failed", 1);
    releaseProbe();
    const summary = await recovery;
    expect((await getRun(runId))?.status).toBe("failed");
    expect((await getRun(runId))?.summary).toBe("first writer failed");
    expect(summary.failed).toBeGreaterThanOrEqual(1);
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

  test("does not infer provider authority from a legacy session-id prefix", async () => {
    const runId = crypto.randomUUID();
    await seed({
      runId,
      threadId: runId,
      parentRunId: null,
      engine: "codex",
      runStatus: "running",
      commandState: "dispatched",
      session: "skynet-thread-looks-runtime",
      sandbox: undefined,
    });
    await setRunSandbox(runId, "sb");
    let probed = false;

    await recoverStaleRuns(async () => {
      probed = true;
      return { status: "completed", summary: "must not adopt" };
    });

    expect(probed).toBe(false);
    expect((await getRun(runId))?.status).toBe("failed");
  });

  test("does not relabel an ambiguous legacy OpenCode row as the current rollout driver", async () => {
    const runId = crypto.randomUUID();
    await acceptRunCommand({
      idempotencyKey: null,
      orgId: ORG,
      actorId: null,
      run: { id: runId, prompt: "legacy", model: "openai/gpt-5.6-luna", engine: "opencode", parentRunId: null, threadId: runId },
    });
    await setRunStatus(runId, "running");
    await setRunEngineSession(runId, "legacy-ambiguous-session");
    await setRunSandbox(runId, "legacy-sandbox");
    await db.execute(sql`update commands set state='dispatched' where run_id=${runId} and kind='run.create'`);
    let probed = false;

    await recoverStaleRuns(async () => {
      probed = true;
      return { status: "completed", summary: "wrong protocol" };
    });

    expect(probed).toBe(false);
    expect((await getRun(runId))?.status).toBe("failed");
  });

  test("does not reconcile a session whose credential epoch is no longer resolvable", async () => {
    const runId = crypto.randomUUID();
    await acceptRunCommand({
      idempotencyKey: null,
      orgId: ORG,
      actorId: null,
      run: { id: runId, prompt: "revoked auth", model: "gpt-5.6-luna", engine: "codex", parentRunId: null, threadId: runId },
    });
    await setRunStatus(runId, "running");
    await setRunSandbox(runId, "auth-sandbox");
    await setRunProviderSession(runId, providerSessionBinding({
      provider: "codex",
      nativeSessionId: "auth-session",
      protocolVersion: "t3-orchestration/useagent-runtime-v8",
      runtime: { kind: "sandbox", id: "auth-sandbox" },
      capabilities: {} as never,
      generation: 2,
    }, "revoked-epoch"));
    await db.execute(sql`update commands set state='dispatched' where run_id=${runId} and kind='run.create'`);
    let probed = false;

    await recoverStaleRuns(async () => {
      probed = true;
      return { status: "completed", summary: "must not adopt" };
    });

    expect(probed).toBe(false);
    expect((await getRun(runId))?.status).toBe("failed");
  });

  test("settles an old ACP session before reconcile and immediately releases its queued turn", async () => {
    const runId = crypto.randomUUID();
    await seed({
      runId,
      threadId: runId,
      parentRunId: null,
      engine: "codex",
      runStatus: "running",
      commandState: "dispatched",
      session: "legacy-acp-session",
      sandbox: "legacy-acp-sandbox",
    });
    await setRunProviderSession(runId, providerSessionBinding({
      provider: "codex",
      nativeSessionId: "legacy-acp-session",
      protocolVersion: "acp/1",
      runtime: { kind: "sandbox", id: "legacy-acp-sandbox" },
      capabilities: {} as never,
      generation: 1,
    }));
    const queued = await seed({
      threadId: runId,
      parentRunId: runId,
      engine: "mock",
      runStatus: "queued",
      commandState: "queued",
    });
    let probed = false;

    const result = await recoverStaleRuns(async () => {
      probed = true;
      return { status: "unreachable" };
    });

    expect(probed).toBe(false);
    expect(result.parked).toBe(0);
    expect((await getRun(runId))?.status).toBe("failed");
    expect((await getRun(runId))?.summary).toBe(INCOMPATIBLE_PROVIDER_SESSION_SUMMARY);
    await waitFor(() => isDone(queued));
  });

  test("keeps a valid native session parked during a transient provider outage", async () => {
    const runId = crypto.randomUUID();
    const driver = t3ProviderDrivers.codex;
    await seed({
      runId,
      threadId: runId,
      parentRunId: null,
      engine: "codex",
      runStatus: "running",
      commandState: "dispatched",
      session: "native-t3-session",
      sandbox: "native-t3-sandbox",
    });
    await setRunProviderSession(runId, providerSessionBinding({
      provider: "codex",
      nativeSessionId: "native-t3-session",
      protocolVersion: providerProtocolIdentity(driver.descriptor.protocol),
      runtime: { kind: "sandbox", id: "native-t3-sandbox" },
      capabilities: driver.descriptor.capabilities,
      generation: driver.descriptor.sessionGeneration as number,
    }));
    let probes = 0;

    const result = await recoverStaleRuns(async () => {
      probes += 1;
      return { status: "unreachable" };
    });

    expect(probes).toBe(1);
    expect(result.parked).toBeGreaterThanOrEqual(1);
    expect((await getRun(runId))?.status).toBe("running");
  });
});
