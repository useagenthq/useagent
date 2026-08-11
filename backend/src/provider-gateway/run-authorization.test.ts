import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../index"; // side-effect: run committed migrations before DB assertions
import { db } from "../db/client";
import { runs } from "../db/schema";
import { findActiveThreadGatewayRun, findRunningGatewayRun } from "./run-authorization";

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

  test("thread resolution: exactly one live run resolves; two (invariant breach) fails closed", async () => {
    const threadId = `thread-${crypto.randomUUID()}`;
    const orgId = `org-${crypto.randomUUID()}`;
    const first = `run-${crypto.randomUUID()}`;
    const second = `run-${crypto.randomUUID()}`;
    ids.push(first, second);
    const row = (id: string, status: "running" | "queued") => ({
      id,
      orgId,
      userId: "user-a",
      prompt: "p",
      model: "gpt-5",
      engine: "codex" as const,
      status,
      threadId,
    });
    await db.insert(runs).values([row(first, "running"), row(second, "queued")]);

    // One live run: resolves to it.
    const resolved = await findActiveThreadGatewayRun({ orgId, threadId, engine: "codex" });
    expect(resolved?.id).toBe(first);

    // Two live runs (the one-live-run-per-thread invariant breached): ambiguity
    // must fail closed rather than pick one.
    await db.update(runs).set({ status: "running" }).where(eq(runs.id, second));
    expect(await findActiveThreadGatewayRun({ orgId, threadId, engine: "codex" })).toBeNull();

    // No live run: inert.
    await db.update(runs).set({ status: "completed" }).where(eq(runs.threadId, threadId));
    expect(await findActiveThreadGatewayRun({ orgId, threadId, engine: "codex" })).toBeNull();

    // Wrong engine: inert (a claude token cannot spend a codex thread's turn).
    await db.update(runs).set({ status: "running" }).where(eq(runs.id, first));
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, second));
    expect(await findActiveThreadGatewayRun({ orgId, threadId, engine: "claude" })).toBeNull();
  });
});

describe("tool-gateway thread-scope identity substitution (cross-user safety)", () => {
  test("a thread capability acts as the CURRENT live run's user, never the minting user", async () => {
    const { resolveToolRunIdentity } = await import("../knowledge/gateway/run-authorization");
    const threadId = `thread-${crypto.randomUUID()}`;
    const orgId = `org-${crypto.randomUUID()}`;
    const mintRun = `run-${crypto.randomUUID()}`;
    const laterRun = `run-${crypto.randomUUID()}`;
    ids.push(mintRun, laterRun);
    await db.insert(runs).values([
      { id: mintRun, orgId, userId: "user-a", prompt: "p", model: "m", engine: "opencode", status: "completed", threadId },
      { id: laterRun, orgId, userId: "user-b", prompt: "p", model: "m", engine: "opencode", status: "running", threadId },
    ]);
    const claims = {
      orgId,
      userId: "user-a", // minting user - must NOT survive resolution
      threadId,
      runId: mintRun,
      scope: "thread" as const,
      exp: Date.now() + 60_000,
    };
    const resolved = await resolveToolRunIdentity(claims);
    expect(resolved?.runId).toBe(laterRun);
    expect(resolved?.userId).toBe("user-b");

    // Run scope is untouched: the minted run is settled, so it stays inert even
    // though the thread is busy.
    expect(await resolveToolRunIdentity({ ...claims, scope: "run" })).toBeNull();
  });
});
