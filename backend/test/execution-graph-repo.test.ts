import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { agentExecutions, delegationEdges, runs } from "../src/db/schema";
import {
  advanceExecutionLifecycle,
  createRootExecution,
  getExecutionGraphForRun,
  recordDelegationControl,
  recordNativeChildSpawn,
} from "../src/runs/execution-graph-repo";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const databaseName = `useagent_execution_graph_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${databaseName}`;

const admin = postgres(ADMIN_URL, { max: 1 });
await admin.unsafe(`create database "${databaseName}"`);
const client = postgres(testUrl.toString(), { max: 2 });
const testDb = drizzle(client, { schema });
await migrate(testDb, { migrationsFolder: `${import.meta.dir}/../drizzle` });

afterAll(async () => {
  await client.end();
  await admin.unsafe(`drop database if exists "${databaseName}"`);
  await admin.end();
});

async function seedRun(orgId: string, runId = crypto.randomUUID()): Promise<string> {
  await testDb.insert(runs).values({
    id: runId,
    orgId,
    prompt: "execution graph fixture",
    model: "mock",
    engine: "mock",
    status: "queued",
    parentRunId: null,
    threadId: runId,
  });
  return runId;
}

describe("execution graph repository", () => {
  test("keeps execution identity immutable and hides missing or cross-org graphs", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    expect(await getExecutionGraphForRun("other-org", runId, testDb)).toBeNull();
    await expect(createRootExecution({
      orgId: "other-org",
      runId,
      sourceKey: "root:cross-org",
      provider: "codex",
    }, testDb)).rejects.toThrow("execution_owning_run_not_found");

    const root = await createRootExecution({
      orgId,
      runId,
      sourceKey: "root:codex:session-1",
      provider: "codex",
      nativeSessionId: "session-1",
      status: "running",
    }, testDb);
    const replay = await createRootExecution({
      orgId,
      runId,
      sourceKey: "root:codex:session-1",
      provider: "codex",
      nativeSessionId: "session-1",
      status: "completed",
    }, testDb);
    expect(replay.id).toBe(root.id);
    expect(replay.status).toBe("running");
    await expect(createRootExecution({
      orgId,
      runId,
      sourceKey: "root:codex:session-1",
      provider: "opencode",
      nativeSessionId: "session-1",
    }, testDb)).rejects.toThrow("execution_source_key_identity_conflict");
    await expect(createRootExecution({
      orgId,
      runId,
      sourceKey: "root:codex:second-root",
      provider: "codex",
      nativeSessionId: "session-2",
    }, testDb)).rejects.toThrow();

    const graph = await getExecutionGraphForRun(orgId, runId, testDb);
    expect(graph).toMatchObject({ version: 1, runId, graphCursor: 0 });
    expect(graph?.executions.map((execution) => execution.id)).toEqual([root.id]);
    expect(graph?.delegationEdges).toEqual([]);
  });

  test("spawn atomically mints one child while control kinds remain edge-only", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    const root = await createRootExecution({
      orgId,
      runId,
      sourceKey: "root:opencode:parent",
      provider: "opencode",
      nativeSessionId: "parent",
      status: "running",
    }, testDb);

    const spawned = await recordNativeChildSpawn({
      orgId,
      runId,
      parentExecutionId: root.id,
      provider: "opencode",
      childSourceKey: "child:opencode:child-1",
      edgeSourceKey: "edge:spawn:call-1",
      nativeSessionId: "child-1",
      nativeParentSessionId: "parent",
      providerCallId: "call-1",
      nativeEventId: "event-1",
      observedDeliverySeq: 5,
    }, testDb);
    const replay = await recordNativeChildSpawn({
      orgId,
      runId,
      parentExecutionId: root.id,
      provider: "opencode",
      childSourceKey: "child:opencode:child-1",
      edgeSourceKey: "edge:spawn:call-1",
      nativeSessionId: "child-1",
      nativeParentSessionId: "parent",
      providerCallId: "call-1",
      nativeEventId: "event-1",
      observedDeliverySeq: 5,
    }, testDb);
    expect(replay.execution.id).toBe(spawned.execution.id);
    expect(replay.edge.id).toBe(spawned.edge.id);
    await expect(recordNativeChildSpawn({
      orgId,
      runId,
      parentExecutionId: root.id,
      provider: "opencode",
      childSourceKey: "child:opencode:missing-provider-identity",
      edgeSourceKey: "edge:spawn:missing-provider-identity",
      nativeSessionId: "child-missing-provider-identity",
      observedDeliverySeq: 5,
    }, testDb)).rejects.toThrow();
    await expect(recordNativeChildSpawn({
      orgId,
      runId,
      parentExecutionId: root.id,
      provider: "opencode",
      childSourceKey: "child:opencode:duplicate-native-session",
      edgeSourceKey: "edge:spawn:duplicate-native-session",
      nativeSessionId: "child-1",
      providerCallId: "duplicate-native-session",
      observedDeliverySeq: 5,
    }, testDb)).rejects.toThrow();
    await advanceExecutionLifecycle({
      orgId,
      runId,
      executionId: spawned.execution.id,
      status: "waiting",
      attempt: 1,
      eventId: "event-child-waiting",
      eventRevision: 1,
      deliverySeq: 5,
    }, testDb);

    const deliveryByKind = { wait: 6, send: 7, resume: 8, close: 9, gather: 10 } as const;
    for (const kind of ["gather", "wait", "send", "resume", "close"] as const) {
      const deliverySeq = deliveryByKind[kind];
      await recordDelegationControl({
        orgId,
        runId,
        sourceKey: `edge:${kind}:call-${deliverySeq - 4}`,
        parentExecutionId: root.id,
        childExecutionId: spawned.execution.id,
        kind,
        provider: "opencode",
        providerCallId: `call-${deliverySeq - 4}`,
        nativeTargetSessionId: "child-1",
        observedDeliverySeq: deliverySeq,
      }, testDb);
    }

    const executionRows = await testDb.select().from(agentExecutions).where(and(
      eq(agentExecutions.orgId, orgId), eq(agentExecutions.runId, runId),
    ));
    const edgeRows = await testDb.select().from(delegationEdges).where(and(
      eq(delegationEdges.orgId, orgId), eq(delegationEdges.runId, runId),
    ));
    expect(executionRows).toHaveLength(2);
    expect(edgeRows).toHaveLength(6);
    const graph = await getExecutionGraphForRun(orgId, runId, testDb);
    expect(graph?.delegationEdges.map((edge) => edge.kind)).toEqual([
      "spawn", "wait", "send", "resume", "close", "gather",
    ]);
    expect(graph?.graphCursor).toBe(10);
  });

  test("composite ownership rejects cross-run and cross-org execution references", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const otherOrgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    const otherRunId = await seedRun(otherOrgId);
    const root = await createRootExecution({
      orgId,
      runId,
      sourceKey: "root:codex:owned",
      provider: "codex",
    }, testDb);
    await expect(recordDelegationControl({
      orgId: otherOrgId,
      runId: otherRunId,
      sourceKey: "edge:wait:cross-scope",
      parentExecutionId: root.id,
      kind: "wait",
      provider: "codex",
      nativeEventId: "event-cross-scope",
      observedDeliverySeq: 1,
    }, testDb)).rejects.toThrow();
    expect(await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.sourceKey, "edge:wait:cross-scope"),
    )).toEqual([]);

    await expect(testDb.transaction(async (tx) => {
      await recordNativeChildSpawn({
        orgId,
        runId,
        parentExecutionId: root.id,
        provider: "codex",
        childSourceKey: "child:codex:caller-rollback",
        edgeSourceKey: "edge:spawn:caller-rollback",
        nativeSessionId: "child-caller-rollback",
        nativeEventId: "event-caller-rollback",
        observedDeliverySeq: 2,
      }, tx);
      throw new Error("caller_rollback");
    })).rejects.toThrow("caller_rollback");
    expect(await testDb.select().from(agentExecutions).where(
      eq(agentExecutions.sourceKey, "child:codex:caller-rollback"),
    )).toEqual([]);
  });

  test("lifecycle watermark rejects stale replay and resume reuses the child identity", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    const root = await createRootExecution({
      orgId,
      runId,
      sourceKey: "root:codex:lifecycle",
      provider: "codex",
    }, testDb);
    const { execution: child } = await recordNativeChildSpawn({
      orgId,
      runId,
      parentExecutionId: root.id,
      provider: "codex",
      childSourceKey: "child:codex:lifecycle",
      edgeSourceKey: "edge:spawn:lifecycle",
      nativeSessionId: "child-lifecycle",
      nativeEventId: "event-spawn-lifecycle",
      observedDeliverySeq: 1,
    }, testDb);

    const firstStartedAt = new Date(Date.now() - 1_000);
    await advanceExecutionLifecycle({
      orgId,
      runId,
      executionId: child.id,
      status: "running",
      attempt: 1,
      eventId: "event-running",
      eventRevision: 0,
      deliverySeq: 2,
      startedAt: firstStartedAt,
    }, testDb);
    const completedAt = new Date();
    expect((await advanceExecutionLifecycle({
      orgId,
      runId,
      executionId: child.id,
      status: "completed",
      attempt: 1,
      eventId: "event-complete",
      eventRevision: 0,
      deliverySeq: 8,
      settledAt: completedAt,
    }, testDb)).applied).toBe(true);
    const stale = await advanceExecutionLifecycle({
      orgId,
      runId,
      executionId: child.id,
      status: "running",
      attempt: 1,
      eventId: "event-stale",
      eventRevision: 9,
      deliverySeq: 7,
    }, testDb);
    expect(stale.applied).toBe(false);
    expect(stale.execution.status).toBe("completed");
    expect(stale.execution.startedAt?.getTime()).toBe(firstStartedAt.getTime());
    for (const [offset, status] of ["queued", "running", "waiting"].entries()) {
      const unapprovedRestart = await advanceExecutionLifecycle({
        orgId,
        runId,
        executionId: child.id,
        status: status as "queued" | "running" | "waiting",
        attempt: 1,
        eventId: `event-unapproved-${status}`,
        eventRevision: 0,
        deliverySeq: 9 + offset,
      }, testDb);
      expect(unapprovedRestart.applied).toBe(false);
      expect(unapprovedRestart.execution.status).toBe("completed");
    }
    const unapprovedCorrection = await advanceExecutionLifecycle({
      orgId,
      runId,
      executionId: child.id,
      status: "failed",
      attempt: 1,
      eventId: "event-unapproved-terminal-correction",
      eventRevision: 0,
      deliverySeq: 12,
    }, testDb);
    expect(unapprovedCorrection.applied).toBe(false);
    expect(unapprovedCorrection.execution.status).toBe("completed");
    const corrected = await advanceExecutionLifecycle({
      orgId,
      runId,
      executionId: child.id,
      status: "failed",
      attempt: 1,
      eventId: "event-approved-terminal-correction",
      eventRevision: 0,
      deliverySeq: 13,
      terminalCorrection: true,
    }, testDb);
    expect(corrected.applied).toBe(true);
    expect(corrected.execution.status).toBe("failed");

    await recordDelegationControl({
      orgId,
      runId,
      sourceKey: "edge:resume:lifecycle",
      parentExecutionId: root.id,
      childExecutionId: child.id,
      kind: "resume",
      provider: "codex",
      nativeEventId: "event-resume-lifecycle",
      observedDeliverySeq: 14,
    }, testDb);
    await recordDelegationControl({
      orgId,
      runId,
      sourceKey: "edge:resume:lifecycle",
      parentExecutionId: root.id,
      childExecutionId: child.id,
      kind: "resume",
      provider: "codex",
      nativeEventId: "event-resume-lifecycle",
      observedDeliverySeq: 14,
    }, testDb);
    const [afterDuplicateResume] = await testDb.select().from(agentExecutions).where(
      eq(agentExecutions.id, child.id),
    );
    expect(afterDuplicateResume?.attempt).toBe(2);
    expect(afterDuplicateResume?.status).toBe("queued");
    const resumed = await advanceExecutionLifecycle({
      orgId,
      runId,
      executionId: child.id,
      status: "running",
      attempt: 2,
      eventId: "event-resumed",
      eventRevision: 0,
      deliverySeq: 15,
      startedAt: new Date(),
      settledAt: null,
    }, testDb);
    expect(resumed).toMatchObject({
      applied: true,
      execution: { id: child.id, attempt: 2, status: "running", settledAt: null },
    });
    expect((await getExecutionGraphForRun(orgId, runId, testDb))?.graphCursor).toBe(15);
  });
});
