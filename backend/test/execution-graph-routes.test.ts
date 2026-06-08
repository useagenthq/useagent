import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { isBearerAllowedPath } from "../src/middleware/bearer";
import { MODEL_QUALIFICATION_RUN_ORIGIN } from "../src/runs/origin";
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
