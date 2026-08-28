import { afterEach, describe, expect, test } from "bun:test";
import { CANONICAL_SCHEMA_VERSION } from "@useagent/agent-harness/canonical";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { isBearerAllowedPath } from "../src/middleware/bearer";
import { MODEL_QUALIFICATION_RUN_ORIGIN } from "../src/runs/origin";
import { persistCanonicalEvents } from "../src/runs/canonical-events";
import { createRootExecution, recordNativeChildSpawn } from "../src/runs/execution-graph-repo";
import {
  executionGraphReadEnabled,
  executionGraphRolloutMode,
} from "../src/runs/execution-graph-rollout";
import { createOrgSession, json, uid } from "./helpers";

const previousMode = process.env.EXECUTION_GRAPH_ROLLOUT;

afterEach(() => {
  if (previousMode === undefined) delete process.env.EXECUTION_GRAPH_ROLLOUT;
  else process.env.EXECUTION_GRAPH_ROLLOUT = previousMode;
});

describe("execution graph rollout", () => {
  test("defaults missing and invalid values to off", () => {
    expect(executionGraphRolloutMode({})).toBe("off");
    expect(executionGraphRolloutMode({ EXECUTION_GRAPH_ROLLOUT: "invalid" })).toBe("off");
    expect(executionGraphRolloutMode({ EXECUTION_GRAPH_ROLLOUT: " SHADOW " })).toBe("shadow");
    expect(executionGraphReadEnabled({ EXECUTION_GRAPH_ROLLOUT: "read" })).toBe(true);
  });

  test("keeps the graph route session-only and hidden until read mode", async () => {
    const owner = await createOrgSession(uid("graph-owner"));
    const outsider = await createOrgSession(uid("graph-outsider"));
    const accepted = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: owner.cookies,
      body: { prompt: "execution graph route", engine: "mock" },
    });
    expect(accepted.status).toBe(201);

    const path = `/api/runs/${accepted.body.id}/executions`;
    expect(isBearerAllowedPath("GET", path)).toBe(false);

    for (const mode of ["off", "shadow"] as const) {
      process.env.EXECUTION_GRAPH_ROLLOUT = mode;
      expect((await json(path, { cookies: owner.cookies })).status).toBe(404);
    }

    process.env.EXECUTION_GRAPH_ROLLOUT = "read";
    const own = await json<{
      version: number;
      run_id: string;
      graph_cursor: number;
      executions: unknown[];
      delegation_edges: unknown[];
      has_more: boolean;
      next_cursor: string | null;
    }>(path, { cookies: owner.cookies });
    expect(own).toEqual({
      status: 200,
      body: {
        version: 1,
        run_id: accepted.body.id,
        graph_cursor: 0,
        executions: [],
        delegation_edges: [],
        has_more: false,
        next_cursor: null,
      },
    });
    expect((await json(path, { cookies: outsider.cookies })).status).toBe(404);

    const rootExecution = await createRootExecution({
      orgId: owner.orgId,
      runId: accepted.body.id,
      sourceKey: "root:opencode:root-session",
      provider: "opencode",
      nativeSessionId: "root-session",
      status: "running",
    });
    const { execution: childExecution } = await recordNativeChildSpawn({
      orgId: owner.orgId,
      runId: accepted.body.id,
      parentExecutionId: rootExecution.id,
      provider: "opencode",
      childSourceKey: "child:opencode:child-session",
      edgeSourceKey: "edge:opencode:spawn:child-session",
      nativeSessionId: "child-session",
      nativeParentSessionId: "root-session",
      providerCallId: "spawn-call",
      nativeEventId: "spawn-event",
      observedDeliverySeq: 1,
    });
    await persistCanonicalEvents([
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: `${accepted.body.id}:root-message`,
        seq: 1,
        runId: accepted.body.id,
        threadId: accepted.body.id,
        ts: 1,
        identity: { provider: "opencode", nativeSessionId: "root-session" },
        kind: "message.completed",
        messageId: "root-message",
        text: "parent only",
      },
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: `${accepted.body.id}:child-message`,
        seq: 2,
        runId: accepted.body.id,
        threadId: accepted.body.id,
        ts: 2,
        identity: {
          provider: "opencode",
          nativeSessionId: "child-session",
          nativeParentSessionId: "root-session",
        },
        kind: "message.completed",
        messageId: "child-message",
        text: "child answer",
      },
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: `${accepted.body.id}:child-tool`,
        seq: 3,
        runId: accepted.body.id,
        threadId: accepted.body.id,
        ts: 3,
        identity: {
          provider: "opencode",
          nativeSessionId: "child-session",
          nativeParentSessionId: "root-session",
        },
        kind: "tool.completed",
        toolCallId: "child-tool",
        status: "ok",
      },
    ]);
    const transcriptPath = `${path}/${childExecution.id}/events`;
    expect(isBearerAllowedPath("GET", transcriptPath)).toBe(false);
    const firstPage = await json<{
      next_cursor: number;
      has_more: boolean;
      events: Array<{ kind: string; identity: { nativeSessionId?: string } }>;
    }>(`${transcriptPath}?limit=1`, { cookies: owner.cookies });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.has_more).toBe(true);
    expect(firstPage.body.events).toHaveLength(1);
    expect(firstPage.body.events[0]).toMatchObject({
      kind: "message.completed",
      identity: { nativeSessionId: "child-session" },
    });
    const secondPage = await json<{ has_more: boolean; events: Array<{ kind: string }> }>(
      `${transcriptPath}?limit=1&cursor=${firstPage.body.next_cursor}`,
      { cookies: owner.cookies },
    );
    expect(secondPage.body).toMatchObject({
      has_more: false,
      events: [{ kind: "tool.completed" }],
    });
    expect((await json(transcriptPath, { cookies: outsider.cookies })).status).toBe(404);

    const internalRunId = crypto.randomUUID();
    await db.insert(runs).values({
      id: internalRunId,
      orgId: owner.orgId,
      prompt: "internal graph fixture",
      model: "mock",
      engine: "mock",
      status: "completed",
      threadId: internalRunId,
      origin: MODEL_QUALIFICATION_RUN_ORIGIN,
    });
    expect(
      (await json(`/api/runs/${internalRunId}/executions`, { cookies: owner.cookies })).status,
    ).toBe(404);
  });

  test("validates bounded graph paging and traverses independent collections without duplicates", async () => {
    process.env.EXECUTION_GRAPH_ROLLOUT = "read";
    const owner = await createOrgSession(uid("graph-page-owner"));
    const outsider = await createOrgSession(uid("graph-page-outsider"));
    const accepted = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: owner.cookies,
      body: { prompt: "paged execution graph", engine: "mock" },
    });
    expect(accepted.status).toBe(201);
    const path = `/api/runs/${accepted.body.id}/executions`;

    for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=1e2", "limit=nope"]) {
      expect((await json(`${path}?${query}`, { cookies: owner.cookies })).status).toBe(400);
    }
    expect((await json(`${path}?cursor=%%%`, { cookies: owner.cookies })).status).toBe(400);
    expect(
      (await json(`${path}?cursor=${"a".repeat(1_025)}`, { cookies: owner.cookies })).status,
    ).toBe(400);
    const invalidCursor = Buffer.from(JSON.stringify({
      v: 1,
      graph_cursor: 0,
      execution: { created_at: new Date().toISOString(), id: "not-a-uuid" },
      delegation_edge: null,
    })).toString("base64url");
    expect(
      (await json(`${path}?cursor=${invalidCursor}`, { cookies: owner.cookies })).status,
    ).toBe(400);
    expect(
      (await json(`${path}?limit=0&cursor=%%%`, { cookies: outsider.cookies })).status,
    ).toBe(404);

    const rootExecution = await createRootExecution({
      orgId: owner.orgId,
      runId: accepted.body.id,
      sourceKey: "root:codex:paged-root",
      provider: "codex",
      nativeSessionId: "paged-root",
      status: "running",
    });
    const expectedExecutionIds = [rootExecution.id];
    const expectedEdgeIds: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const child = await recordNativeChildSpawn({
        orgId: owner.orgId,
        runId: accepted.body.id,
        parentExecutionId: rootExecution.id,
        provider: "codex",
        childSourceKey: `child:codex:paged-${index}`,
        edgeSourceKey: `edge:codex:spawn:paged-${index}`,
        nativeSessionId: `paged-${index}`,
        nativeParentSessionId: "paged-root",
        providerCallId: `spawn-paged-${index}`,
        observedDeliverySeq: index,
      });
      expectedExecutionIds.push(child.execution.id);
      expectedEdgeIds.push(child.edge.id);
    }

    interface GraphPageBody {
      readonly graph_cursor: number;
      readonly executions: Array<{ readonly id: string }>;
      readonly delegation_edges: Array<{ readonly id: string }>;
      readonly has_more: boolean;
      readonly next_cursor: string | null;
    }
    const seenExecutionIds: string[] = [];
    const seenEdgeIds: string[] = [];
    let cursor: string | null = null;
    let terminalCursor: string | null = null;
    let previousGraphCursor = 0;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await json<GraphPageBody>(
        `${path}?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        { cookies: owner.cookies },
      );
      expect(page.status).toBe(200);
      expect(page.body.executions.length).toBeLessThanOrEqual(2);
      expect(page.body.delegation_edges.length).toBeLessThanOrEqual(2);
      expect(page.body.graph_cursor).toBeGreaterThanOrEqual(previousGraphCursor);
      previousGraphCursor = page.body.graph_cursor;
      seenExecutionIds.push(...page.body.executions.map((row) => row.id));
      seenEdgeIds.push(...page.body.delegation_edges.map((row) => row.id));
      expect(page.body.next_cursor).not.toBeNull();
      cursor = page.body.next_cursor;
      if (!page.body.has_more) {
        terminalCursor = cursor;
        break;
      }
    }

    expect(terminalCursor).not.toBeNull();
    expect(previousGraphCursor).toBe(5);
    expect(new Set(seenExecutionIds).size).toBe(seenExecutionIds.length);
    expect(new Set(seenEdgeIds).size).toBe(seenEdgeIds.length);
    expect(new Set(seenExecutionIds)).toEqual(new Set(expectedExecutionIds));
    expect(new Set(seenEdgeIds)).toEqual(new Set(expectedEdgeIds));

    const appended = await recordNativeChildSpawn({
      orgId: owner.orgId,
      runId: accepted.body.id,
      parentExecutionId: rootExecution.id,
      provider: "codex",
      childSourceKey: "child:codex:paged-appended",
      edgeSourceKey: "edge:codex:spawn:paged-appended",
      nativeSessionId: "paged-appended",
      nativeParentSessionId: "paged-root",
      providerCallId: "spawn-paged-appended",
      // Same provider delivery sequence as an already-paged edge: the database
      // insertion cursor must still surface this later commit exactly once.
      observedDeliverySeq: 5,
    });
    const incremental = await json<GraphPageBody>(
      `${path}?limit=2&cursor=${terminalCursor}`,
      { cookies: owner.cookies },
    );
    expect(incremental).toMatchObject({
      status: 200,
      body: {
        graph_cursor: 5,
        executions: [{ id: appended.execution.id }],
        delegation_edges: [{ id: appended.edge.id }],
        has_more: false,
      },
    });
    expect(incremental.body.next_cursor).not.toBeNull();
    expect(incremental.body.next_cursor).not.toBe(terminalCursor);
  });
});
