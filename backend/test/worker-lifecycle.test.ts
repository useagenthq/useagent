import { describe, expect, test } from "bun:test";
import { beginEngineRun } from "../src/worker";
import { createRun, getRunWithSteps } from "../src/runs/repo";

const ORG_ID = "org-skynet-dev";

describe("real engine lifecycle", () => {
  test("publishes a durable preparation row before adapter-owned work", async () => {
    const runId = crypto.randomUUID();
    await createRun({
      id: runId,
      prompt: "inspect the repository",
      model: "test-model",
      engine: "opencode",
      orgId: ORG_ID,
      userId: null,
      parentRunId: null,
      threadId: runId,
      repos: [],
      memoryScope: "org",
    });

    const nextStep = await beginEngineRun(runId, runId);
    const run = await getRunWithSteps(ORG_ID, runId);

    expect(nextStep).toBe(1);
    expect(run?.status).toBe("running");
    expect(run?.steps).toHaveLength(1);
    expect(run?.steps[0]).toMatchObject({
      idx: 0,
      kind: "task",
      label: "Preparing context and runtime…",
      chip: "boot",
    });
    expect(JSON.parse(run?.steps[0]?.code_json ?? "null")).toEqual({ phase: "preparing" });
  });
});
