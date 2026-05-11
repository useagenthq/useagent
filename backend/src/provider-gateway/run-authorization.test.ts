import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../index"; // side-effect: run committed migrations before DB assertions
import { db } from "../db/client";
import { runs } from "../db/schema";
import { findRunningGatewayRun } from "./run-authorization";

const ids: string[] = [];

afterEach(async () => {
  for (const id of ids.splice(0)) {
    await db.delete(runs).where(eq(runs.id, id));
  }
});

describe("provider gateway run authorization", () => {
  test("a capability resolves its exact run, never the newest turn in a thread", async () => {
    const threadId = `thread-${crypto.randomUUID()}`;
    const orgId = `org-${crypto.randomUUID()}`;
    const oldRunId = `run-${crypto.randomUUID()}`;
    const newRunId = `run-${crypto.randomUUID()}`;
    ids.push(oldRunId, newRunId);
    await db.insert(runs).values([
      {
        id: oldRunId,
        orgId,
        userId: "user-a",
        prompt: "old",
        model: "gpt-5",
        engine: "codex",
        status: "running",
        threadId,
      },
      {
        id: newRunId,
        orgId,
        userId: "user-a",
        prompt: "new",
        model: "gpt-5",
        engine: "codex",
        status: "running",
        threadId,
      },
    ]);

    const resolved = await findRunningGatewayRun({
      runId: oldRunId,
      orgId,
      threadId,
      engine: "codex",
    });
    expect(resolved?.id).toBe(oldRunId);

    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, oldRunId));
    expect(
      await findRunningGatewayRun({ runId: oldRunId, orgId, threadId, engine: "codex" }),
    ).toBeNull();
  });
});
