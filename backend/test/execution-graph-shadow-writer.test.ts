import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { agentExecutions, delegationEdges, runs } from "../src/db/schema";
import { executionGraphWriteEnabled } from "../src/runs/execution-graph-rollout";
import {
  executionGraphObservationKind,
  shadowWriteExecutionGraph,
} from "../src/runs/execution-graph-shadow-writer";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const databaseName = `useagent_graph_shadow_${crypto.randomUUID().replaceAll("-", "")}`;
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

async function seedRun(orgId: string): Promise<string> {
  const runId = crypto.randomUUID();
  await testDb.insert(runs).values({
    id: runId,
    orgId,
    prompt: "shadow graph fixture",
    model: "mock",
    engine: "mock",
    status: "queued",
    parentRunId: null,
    threadId: runId,
  });
  return runId;
}

describe("execution graph shadow writer", () => {
  test("keeps the writer disabled in off mode and enabled for shadow/read", () => {
    expect(executionGraphWriteEnabled({})).toBe(false);
    expect(executionGraphWriteEnabled({ EXECUTION_GRAPH_ROLLOUT: "off" })).toBe(false);
    expect(executionGraphWriteEnabled({ EXECUTION_GRAPH_ROLLOUT: "shadow" })).toBe(true);
    expect(executionGraphWriteEnabled({ EXECUTION_GRAPH_ROLLOUT: "read" })).toBe(true);
  });

  test("classifies only graph-semantic events before any database lookup", () => {
    const base = {
      id: "event",
      runId: "run",
      threadId: "run",
      provider: "t3",
      nativeSessionId: "root",
    } as const;
    expect(executionGraphObservationKind({
      ...base,
      eventType: "t3.activity.message.delta",
      payload: { kind: "message.delta", payload: { text: "hello" } },
    })).toBeNull();
    expect(executionGraphObservationKind({
      ...base,
      eventType: "t3.activity.tool.completed",
      payload: { kind: "tool.completed", payload: { toolName: "bash" } },
    })).toBeNull();
    expect(executionGraphObservationKind({
      ...base,
      eventType: "t3.activity.task.completed",
      nativeSessionId: "child",
      nativeParentSessionId: "root",
      payload: {
        kind: "task.completed",
        payload: { taskId: "child", parentAgentId: "root", agentKind: "agent" },
      },
    })).toBe("lifecycle");
    expect(executionGraphObservationKind({
      ...base,
      eventType: "t3.activity.tool.completed",
      payload: {
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          delegationKind: "wait",
          detail: '<task id="child-from-wait" state="completed"></task>',
        },
      },
    })).toBe("control");
  });

  test("writes only explicit OpenCode root and parent-linked child identities", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await shadowWriteExecutionGraph({
      id: `${runId}:root:session`,
      runId,
      threadId: runId,
      provider: "opencode",
      eventType: "session.started",
      nativeSessionId: "root-session",
    }, 0, testDb);
    await shadowWriteExecutionGraph({
      id: `${runId}:child:session`,
      runId,
      threadId: runId,
      provider: "opencode",
      eventType: "session.created",
      nativeSessionId: "child-session",
      nativeParentSessionId: "root-session",
    }, 1, testDb);
    await shadowWriteExecutionGraph({
      id: `${runId}:task-wrapper`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.started",
      nativeSessionId: "parent",
      nativeCallId: "wrapper-call",
      payload: {
        kind: "tool.started",
        payload: {
          itemType: "collab_agent_tool_call",
          delegationKind: "spawn",
          childSessionId: "child",
          toolUseId: "wrapper-call",
        },
      },
    }, 2, testDb);
    await shadowWriteExecutionGraph({
      id: `${runId}:resume-control-started`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.started",
      nativeSessionId: "parent",
      nativeCallId: "resume-call",
      payload: {
        kind: "tool.started",
        payload: {
          itemType: "collab_agent_tool_call",
          delegationKind: "resume",
          childSessionId: "child",
          toolUseId: "resume-call",
        },
      },
    }, 3, testDb);
    await shadowWriteExecutionGraph({
      id: `${runId}:ambiguous-child`,
      runId,
      threadId: runId,
      provider: "opencode",
      eventType: "session.updated",
      nativeSessionId: "ambiguous-child",
    }, 4, testDb);

    const executions = await testDb.select().from(agentExecutions).where(and(
      eq(agentExecutions.orgId, orgId),
      eq(agentExecutions.runId, runId),
    ));
    expect(executions).toHaveLength(2);
    expect(executions.map((row) => [row.mode, row.nativeSessionId]).sort()).toEqual([
      ["native_child", "child-session"],
      ["root", "root-session"],
    ]);
    expect(await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).toHaveLength(1);
  });

  test("attaches live Codex children to the unique root when provider parent identity differs", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await shadowWriteExecutionGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: `product-thread-${runId}`,
    }, 0, testDb);
    await shadowWriteExecutionGraph({
      id: `${runId}:child-started`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.started",
      nativeSessionId: "provider-child-a",
      nativeParentSessionId: "provider-parent-thread",
      nativeCallId: "provider-child-a",
      payload: {
        kind: "task.started",
        payload: {
          taskId: "provider-child-a",
          parentAgentId: "provider-parent-thread",
          agentKind: "agent",
          title: "calc_a",
          agentPath: "/root/calc_a",
        },
      },
    }, 1, testDb);

    const executions = await testDb.select().from(agentExecutions).where(
      eq(agentExecutions.runId, runId),
    );
    const root = executions.find((row) => row.mode === "root");
    const child = executions.find((row) => row.mode === "native_child");
    expect(root?.nativeSessionId).toBe(`product-thread-${runId}`);
    expect(child).toMatchObject({
      nativeSessionId: "provider-child-a",
      nativeParentSessionId: "provider-parent-thread",
      status: "running",
    });
    expect(await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).toEqual([
      expect.objectContaining({
        parentExecutionId: root?.id,
        childExecutionId: child?.id,
        kind: "spawn",
      }),
    ]);
  });

  test("never mis-parents a reversed nested child to the root", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await shadowWriteExecutionGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: `product-thread-${runId}`,
    }, 0, testDb);
    await shadowWriteExecutionGraph({
      id: `${runId}:nested-before-parent`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.started",
      nativeSessionId: "provider-child-b",
      nativeParentSessionId: "provider-child-a",
      payload: {
        kind: "task.started",
        payload: {
          taskId: "provider-child-b",
          parentAgentId: "provider-child-a",
          agentKind: "agent",
          agentPath: "/root/calc_a/nested_b",
        },
      },
    }, 1, testDb);
    expect(await testDb.select().from(agentExecutions).where(and(
      eq(agentExecutions.runId, runId),
      eq(agentExecutions.mode, "native_child"),
    ))).toEqual([]);
    expect(await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).toEqual([]);
  });

  test("recovers an OpenCode child identity from a completed task receipt", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await shadowWriteExecutionGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: `product-thread-${runId}`,
    }, 0, testDb);
    await shadowWriteExecutionGraph({
      id: `${runId}:delegate-complete`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.completed",
      nativeSessionId: `product-thread-${runId}`,
      payload: {
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          toolCallId: "call-child-b",
          status: "completed",
          detail: '<task id="ses_child_b" state="completed"><task_result>667</task_result></task>',
          data: { toolCallId: "call-child-b" },
        },
      },
    }, 1, testDb);

    const [child] = await testDb.select().from(agentExecutions).where(and(
      eq(agentExecutions.runId, runId),
      eq(agentExecutions.mode, "native_child"),
    ));
    expect(child).toMatchObject({ nativeSessionId: "ses_child_b", status: "completed" });
    expect(child?.settledAt).toBeInstanceOf(Date);
    expect(await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).toEqual([
      expect.objectContaining({
        childExecutionId: child?.id,
        kind: "spawn",
        providerCallId: "call-child-b",
      }),
    ]);
  });

  test("keeps T3 resume observations edge-only and does not mutate attempts", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await shadowWriteExecutionGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: "parent",
    }, 0, testDb);
    await shadowWriteExecutionGraph({
      id: `${runId}:task`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.started",
      nativeSessionId: "child",
      nativeParentSessionId: "parent",
      nativeCallId: "child",
      payload: {
        kind: "task.started",
        payload: {
          taskId: "child",
          parentAgentId: "parent",
          toolUseId: "spawn-call",
          agentKind: "agent",
          status: "running",
        },
      },
    }, 1, testDb);
    await shadowWriteExecutionGraph({
      id: `${runId}:resume-control`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.completed",
      nativeSessionId: "parent",
      nativeCallId: "resume-call",
      payload: {
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          delegationKind: "resume",
          childSessionId: "child",
          toolUseId: "resume-call",
        },
      },
    }, 2, testDb);
    await shadowWriteExecutionGraph({
      id: `${runId}:child-tool-complete`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.completed",
      nativeSessionId: "child",
      nativeParentSessionId: "parent",
      payload: { kind: "tool.completed", payload: { toolName: "bash" } },
    }, 3, testDb);

    const [child] = await testDb.select().from(agentExecutions).where(and(
      eq(agentExecutions.runId, runId),
      eq(agentExecutions.nativeSessionId, "child"),
    ));
    expect(child).toMatchObject({ attempt: 1, status: "running" });
    expect((await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).map((edge) => edge.kind)).toEqual(["spawn", "resume"]);
  });

  test("does not fabricate a Pi child from its current parent-owned event shape", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await shadowWriteExecutionGraph({
      id: `${runId}:child-progress`,
      runId,
      threadId: runId,
      provider: "pi",
      eventType: "part.subtask",
      nativeSessionId: "parent",
      nativeParentSessionId: "parent",
      nativeCallId: "child",
      payload: { state: { status: "running" } },
    }, 1, testDb);
    expect(await testDb.select().from(agentExecutions).where(and(
      eq(agentExecutions.runId, runId),
      eq(agentExecutions.mode, "native_child"),
    ))).toEqual([]);

  });

  test("fails open for unsupported and malformed observations", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await expect(shadowWriteExecutionGraph({
      id: `${runId}:unsupported`,
      runId,
      threadId: runId,
      provider: "acp",
      eventType: "session.started",
      nativeSessionId: "ignored",
    }, 0, testDb)).resolves.toBeUndefined();
    await expect(shadowWriteExecutionGraph({
      id: `${runId}:unknown`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.unknown",
      payload: { unexpected: true },
    }, 1, testDb)).resolves.toBeUndefined();
    await shadowWriteExecutionGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: "root-one",
    }, 2, testDb);
    await expect(shadowWriteExecutionGraph({
      id: `${runId}:conflicting-root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: "root-two",
    }, 3, testDb)).resolves.toBeUndefined();
    expect(await testDb.select().from(agentExecutions).where(
      eq(agentExecutions.runId, runId),
    )).toHaveLength(1);
  });
});
