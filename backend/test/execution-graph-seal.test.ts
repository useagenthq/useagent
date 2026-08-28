import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { agentExecutions, providerEvents, runs } from "../src/db/schema";
import {
  executionGraphSealInternals,
  prepareExecutionGraphSeal,
  sealExecutionGraphAfterFinalizeTx,
} from "../src/runs/execution-graph-seal";
import {
  advanceExecutionLifecycle,
  createRootExecution,
  getExecutionGraphForRun,
  recordNativeChildSpawn,
} from "../src/runs/execution-graph-repo";
import { finalizeRun } from "../src/runs/finalize";
import { completeRun, createRun, getRun } from "../src/runs/repo";
import "./helpers";

const ORG = "org-useagent-execution-seal";

async function freshRun(): Promise<string> {
  const id = crypto.randomUUID();
  await createRun({
    id,
    prompt: "execution graph seal",
    model: "openrouter/test",
    engine: "opencode",
    orgId: ORG,
    userId: null,
    parentRunId: null,
    threadId: id,
    origin: "internal:execution-graph-seal-test",
  });
  return id;
}

async function graphFixture(runId: string, provider = "opencode") {
  const parentSession = `ses_parent_${runId}`;
  const root = await createRootExecution({
    orgId: ORG,
    runId,
    sourceKey: `root:${provider}:${parentSession}`,
    provider,
    nativeSessionId: parentSession,
    status: "running",
  });
  const child = async (label: string) => {
    const nativeSessionId = `ses_${label}_${runId}`;
    const spawned = await recordNativeChildSpawn({
      orgId: ORG,
      runId,
      parentExecutionId: root.id,
      provider,
      childSourceKey: `child:${provider}:${nativeSessionId}`,
      edgeSourceKey: `edge:${provider}:spawn:${nativeSessionId}`,
      nativeSessionId,
      nativeParentSessionId: parentSession,
      providerCallId: `call_${label}_${runId}`,
      nativeEventId: `event_${label}_${runId}`,
      observedDeliverySeq: 1,
    });
    return spawned.execution;
  };
  return { root, child };
}

async function event(
  runId: string,
  seq: number,
  eventType: string,
  payload: unknown,
): Promise<void> {
  await db.insert(providerEvents).values({
    id: `${runId}:seal:${seq}`,
    runId,
    threadId: runId,
    seq,
    provider: "opencode",
    eventType,
    nativeSessionId: `ses_parent_${runId}`,
    nativePartId: `part_${seq}`,
    payload: JSON.stringify(payload),
  });
}

afterEach(() => {
  delete process.env.EXECUTION_GRAPH_ROLLOUT;
});

describe("execution graph terminal seal", () => {
  test("OFF skips the drain and leaves graph rows untouched", async () => {
    let drained = 0;
    await prepareExecutionGraphSeal("run-off", "off", async () => { drained += 1; });
    expect(drained).toBe(0);
    await prepareExecutionGraphSeal("run-shadow", "shadow", async () => { drained += 1; });
    await prepareExecutionGraphSeal("run-read", "read", async () => { drained += 1; });
    expect(drained).toBe(2);

    const runId = await freshRun();
    const { root } = await graphFixture(runId);
    process.env.EXECUTION_GRAPH_ROLLOUT = "off";
    await finalizeRun(runId, "completed", "done", 1);
    const graph = await getExecutionGraphForRun(ORG, runId);
    expect(graph?.executions.find((row) => row.id === root.id)?.status).toBe("running");
  });

  test("exact task success/error settles children; generic tools cannot false-positive", async () => {
    const runId = await freshRun();
    const { root, child } = await graphFixture(runId);
    const success = await child("success");
    const failed = await child("failed");
    const generic = await child("generic");
    const unresolved = await child("unresolved");
    const wrongParent = await recordNativeChildSpawn({
      orgId: ORG,
      runId,
      parentExecutionId: root.id,
      provider: "opencode",
      childSourceKey: `child:opencode:ses_wrong_parent_${runId}`,
      edgeSourceKey: `edge:opencode:spawn:ses_wrong_parent_${runId}`,
      nativeSessionId: `ses_wrong_parent_${runId}`,
      nativeParentSessionId: `ses_other_parent_${runId}`,
      providerCallId: `call_wrong_parent_${runId}`,
      nativeEventId: `event_wrong_parent_${runId}`,
      observedDeliverySeq: 1,
    });
    const crossProvider = await db.insert(agentExecutions).values({
      orgId: ORG,
      runId,
      sourceKey: `child:t3:${success.nativeSessionId}`,
      mode: "native_child",
      provider: "t3",
      nativeSessionId: success.nativeSessionId,
      nativeParentSessionId: root.nativeSessionId,
      status: "running",
    }).returning().then((rows) => rows[0]!);

    await event(runId, 8, "part.tool.completed", {
      type: "tool",
      tool: "task",
      state: { status: "completed", output: "ok", metadata: { sessionId: success.nativeSessionId } },
    });
    await event(runId, 9, "part.tool.error", {
      type: "tool",
      tool: "task",
      state: { status: "error", output: `<task id="${failed.nativeSessionId}">failed</task>` },
    });
    await event(runId, 10, "part.tool.completed", {
      type: "tool",
      tool: "bash",
      title: generic.nativeSessionId,
      state: { status: "completed", metadata: { sessionId: generic.nativeSessionId } },
    });
    await event(runId, 11, "part.tool.completed", {
      type: "tool",
      tool: "task",
      state: {
        status: "completed",
        metadata: { sessionId: wrongParent.execution.nativeSessionId },
      },
    });

    process.env.EXECUTION_GRAPH_ROLLOUT = "read";
    await finalizeRun(runId, "completed", "done", 1);
    const graph = await getExecutionGraphForRun(ORG, runId);
    const byId = new Map(graph?.executions.map((row) => [row.id, row]));
    expect(byId.get(root.id)?.status).toBe("completed");
    expect(byId.get(success.id)?.status).toBe("completed");
    expect(byId.get(failed.id)?.status).toBe("failed");
    expect(byId.get(generic.id)?.status).toBe("cancelled");
    expect(byId.get(unresolved.id)?.status).toBe("cancelled");
    expect(byId.get(wrongParent.execution.id)?.status).toBe("cancelled");
    expect(byId.get(crossProvider.id)?.status).toBe("cancelled");
    for (const row of byId.values()) {
      expect(row.lastDeliverySeq).toBe(11);
      expect(row.lastEventId).toBe(executionGraphSealInternals.sealEventId(runId, 11));
    }
  });

  test("existing terminal child verdict is preserved while unresolved children cancel", async () => {
    const runId = await freshRun();
    const { root, child } = await graphFixture(runId, "t3");
    const terminal = await child("terminal");
    const unresolved = await child("still-running");
    await advanceExecutionLifecycle({
      orgId: ORG,
      runId,
      executionId: root.id,
      status: "completed",
      attempt: root.attempt,
      eventId: "t3-root-provider-completed",
      eventRevision: 1,
      deliverySeq: 7,
      settledAt: new Date(),
    });
    await advanceExecutionLifecycle({
      orgId: ORG,
      runId,
      executionId: terminal.id,
      status: "completed",
      attempt: terminal.attempt,
      eventId: "t3-terminal-verdict",
      eventRevision: 1,
      deliverySeq: 7,
      settledAt: new Date(),
    });

    process.env.EXECUTION_GRAPH_ROLLOUT = "read";
    await finalizeRun(runId, "failed", "parent failed", 1);
    const graph = await getExecutionGraphForRun(ORG, runId);
    const byId = new Map(graph?.executions.map((row) => [row.id, row]));
    // Parent finalization is authoritative for the root even when a provider
    // completion raced a user cancellation/failure.
    expect(byId.get(root.id)?.status).toBe("failed");
    expect(byId.get(terminal.id)).toMatchObject({
      status: "completed",
      lastEventId: "t3-terminal-verdict",
      lastDeliverySeq: 7,
    });
    expect(byId.get(unresolved.id)?.status).toBe("cancelled");
  });

  test("the first finalizer seals once and a racing loser is a total no-op", async () => {
    const runId = await freshRun();
    const { root } = await graphFixture(runId);
    process.env.EXECUTION_GRAPH_ROLLOUT = "read";
    await finalizeRun(runId, "completed", "first", 1);
    const first = (await getExecutionGraphForRun(ORG, runId))?.executions.find((row) => row.id === root.id);
    await finalizeRun(runId, "failed", "second", 2);
    const second = (await getExecutionGraphForRun(ORG, runId))?.executions.find((row) => row.id === root.id);
    expect(await getRun(runId)).toMatchObject({ status: "completed", summary: "first" });
    expect(second).toMatchObject({
      status: first?.status,
      lastEventId: first?.lastEventId,
      lastEventRevision: first?.lastEventRevision,
      lastDeliverySeq: first?.lastDeliverySeq,
      settledAt: first?.settledAt,
    });
  });

  test("SHADOW rolls back its savepoint but commits parent; READ rolls back parent", async () => {
    const shadowRun = await freshRun();
    const shadowPrompt = (await getRun(shadowRun))!.prompt;
    const warnings: string[] = [];
    await db.transaction(async (tx) => {
      expect(await completeRun(shadowRun, "completed", "shadow-parent", 1, tx)).toBe(true);
      await sealExecutionGraphAfterFinalizeTx(
        { orgId: ORG, runId: shadowRun, status: "completed", mode: "shadow" },
        tx,
        {
          reconcile: async (_input, savepoint) => {
            await savepoint.update(runs).set({ prompt: "shadow-leak" }).where(eq(runs.id, shadowRun));
            throw new Error("shadow boom");
          },
          warn: (_message, context) => warnings.push(context.error),
        },
      );
    });
    expect(await getRun(shadowRun)).toMatchObject({
      status: "completed",
      summary: "shadow-parent",
      prompt: shadowPrompt,
    });
    expect(warnings).toEqual(["shadow boom"]);

    const readRun = await freshRun();
    const readPrompt = (await getRun(readRun))!.prompt;
    await expect(db.transaction(async (tx) => {
      expect(await completeRun(readRun, "completed", "read-parent", 1, tx)).toBe(true);
      await sealExecutionGraphAfterFinalizeTx(
        { orgId: ORG, runId: readRun, status: "completed", mode: "read" },
        tx,
        {
          reconcile: async (_input, outer) => {
            await outer.update(runs).set({ prompt: "read-leak" }).where(eq(runs.id, readRun));
            throw new Error("read boom");
          },
        },
      );
    })).rejects.toThrow("read boom");
    expect(await getRun(readRun)).toMatchObject({ status: "queued", summary: null, prompt: readPrompt });
  });

  test("malformed and non-task payloads are ignored", () => {
    expect(executionGraphSealInternals.parseTaskEvidence("part.tool.completed", "not-json", "ses_parent")).toBeNull();
    expect(executionGraphSealInternals.parseTaskEvidence("part.tool.running", JSON.stringify({
      type: "tool", tool: "task", state: { metadata: { sessionId: "ses_child" } },
    }), "ses_parent")).toBeNull();
    expect(executionGraphSealInternals.parseTaskEvidence("part.tool.completed", JSON.stringify({
      type: "tool", tool: "bash", state: { metadata: { sessionId: "ses_child" } },
    }), "ses_parent")).toBeNull();
    expect(executionGraphSealInternals.parseTaskEvidence("part.tool.completed", JSON.stringify({
      type: "tool", tool: "task", state: { metadata: { sessionId: "ses_child" } },
    }), null)).toBeNull();
  });

  test("unsupported-provider evidence does not create graph rows", async () => {
    const runId = await freshRun();
    await db.insert(providerEvents).values({
      id: `${runId}:unsupported:1`,
      runId,
      threadId: runId,
      seq: 1,
      provider: "future-harness",
      eventType: "part.tool.completed",
      payload: JSON.stringify({
        type: "tool",
        tool: "task",
        state: { metadata: { sessionId: `ses_future_${runId}` } },
      }),
    });
    process.env.EXECUTION_GRAPH_ROLLOUT = "read";
    await finalizeRun(runId, "completed", "done", 1);
    expect((await getExecutionGraphForRun(ORG, runId))?.executions).toEqual([]);
  });
});
