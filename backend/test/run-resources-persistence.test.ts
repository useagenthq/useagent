import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { acceptRunCommand } from "../src/commands";
import { db } from "../src/db/client";
import { commands, runs } from "../src/db/schema";
import type { RunResource } from "../src/resources/types";
import { createRun, getRunWithSteps } from "../src/runs/repo";
import { waitFor } from "./helpers";

const ORG = "org-skynet-dev";

const pullRequestResource: RunResource = {
  kind: "code.change",
  provider: "github",
  locator: {
    type: "github.pull_request",
    repository: "acme/api",
    number: 42,
    revision: "abc123",
  },
  capabilities: [
    "content.read",
    "code.checkout",
    "change.read",
    "change.checks.read",
    "deployment.read",
  ],
  provenance: [
    {
      source: "user_text",
      channel: "web",
      raw: "https://github.com/acme/api/pull/42",
      start: 5,
      end: 39,
    },
  ],
};

beforeAll(async () => {
  await waitFor(() => true, 1);
});

describe("run resolved-resource persistence", () => {
  test("command acceptance atomically persists resources in the run and audit payload", async () => {
    const runId = crypto.randomUUID();
    const outcome = await acceptRunCommand({
      idempotencyKey: `resource-${crypto.randomUUID()}`,
      orgId: ORG,
      actorId: null,
      run: {
        id: runId,
        prompt: "test this pull request",
        model: "claude-opus-5",
        engine: "mock",
        parentRunId: null,
        threadId: runId,
        repos: ["acme/api"],
        resolvedResources: [pullRequestResource],
        memoryScope: "org",
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    });

    expect(outcome.status).toBe("created");

    const [runRow] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(runRow?.resolvedResources).toEqual([pullRequestResource]);

    const [commandRow] = await db
      .select({ payload: commands.payload })
      .from(commands)
      .where(eq(commands.runId, runId));
    expect(JSON.parse(commandRow!.payload).resolvedResources).toEqual([pullRequestResource]);

    const apiRun = await getRunWithSteps(ORG, runId);
    expect(apiRun?.resolved_resources).toEqual([pullRequestResource]);
  });

  test("old callers serialize an empty resource list", async () => {
    const runId = crypto.randomUUID();
    await createRun({
      id: runId,
      prompt: "legacy caller",
      model: "claude-opus-5",
      engine: "mock",
      orgId: ORG,
      userId: null,
      parentRunId: null,
      threadId: runId,
      repos: [],
      memoryScope: "org",
    });

    expect((await getRunWithSteps(ORG, runId))?.resolved_resources).toEqual([]);
  });
});
