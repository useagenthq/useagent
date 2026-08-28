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
    }>(path, { cookies: owner.cookies });
    expect(own).toEqual({
      status: 200,
      body: {
        version: 1,
        run_id: accepted.body.id,
        graph_cursor: 0,
        executions: [],
        delegation_edges: [],
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
});
