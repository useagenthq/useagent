import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { acceptRunCommand } from "../commands";
import { db } from "../db/client";
import { commands, runs } from "../db/schema";
import type { SandboxHandle, SandboxProvider } from "../sandboxes/provider";
import {
  createRun,
  getThreadSandbox,
  setRunEngineSession,
  setRunSandbox,
  setRunStatus,
} from "./repo";
import { releaseRunSandbox } from "./sandbox-release";

const createdRuns = new Set<string>();

afterEach(async () => {
  for (const id of createdRuns) await db.delete(commands).where(eq(commands.runId, id));
  for (const id of [...createdRuns].reverse()) await db.delete(runs).where(eq(runs.id, id));
  createdRuns.clear();
});

async function runFixture(status: "running" | "completed" = "completed"): Promise<{
  orgId: string;
  runId: string;
  sandboxId: string;
}> {
  const orgId = `org-release-${crypto.randomUUID()}`;
  const runId = crypto.randomUUID();
  const sandboxId = `sandbox-${crypto.randomUUID()}`;
  createdRuns.add(runId);
  await createRun({
    id: runId,
    prompt: "parity case",
    model: "mock-model",
    engine: "mock",
    orgId,
    userId: "user-1",
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  await setRunSandbox(runId, sandboxId);
  await setRunStatus(runId, status);
  return { orgId, runId, sandboxId };
}

function fakeProvider(liveIds: Set<string>, getFails = false): {
  provider: SandboxProvider;
  deleted: string[];
} {
  const deleted: string[] = [];
  const handle = (id: string): SandboxHandle => ({
    id,
    cpu: 1,
    memory: 1,
    process: {} as SandboxHandle["process"],
    fs: {} as SandboxHandle["fs"],
    start: async () => {},
    delete: async () => {
      deleted.push(id);
      liveIds.delete(id);
    },
    getPreviewLink: async () => ({ url: "https://example.invalid" }),
  });
  return {
    deleted,
    provider: {
      create: async () => handle("created"),
      get: async (id) => {
        if (getFails || !liveIds.has(id)) throw new Error("not found");
        return handle(id);
      },
      async *list() {
        for (const id of liveIds) yield handle(id);
      },
    },
  };
}

describe("explicit sandbox release", () => {
  test("deletes only a settled org-scoped thread sandbox and clears its mapping", async () => {
    const fixture = await runFixture();
    const live = new Set([fixture.sandboxId, "unrelated-sandbox"]);
    const { provider, deleted } = fakeProvider(live);

    const result = await releaseRunSandbox(fixture.orgId, fixture.runId, { provider });

    expect(result).toEqual({ ok: true, released: true, sandboxId: fixture.sandboxId });
    expect(deleted).toEqual([fixture.sandboxId]);
    expect(live).toContain("unrelated-sandbox");
    expect(await getThreadSandbox(fixture.runId)).toBeNull();
  });

  test("removes a retained Pi bridge after deleting its sandbox", async () => {
    const fixture = await runFixture();
    const sessionFile = `/sessions/${crypto.randomUUID()}.jsonl`;
    await db.update(runs).set({ engine: "pi" }).where(eq(runs.id, fixture.runId));
    await setRunEngineSession(fixture.runId, sessionFile);
    const { provider } = fakeProvider(new Set([fixture.sandboxId]));
    const removed: string[] = [];

    expect(await releaseRunSandbox(fixture.orgId, fixture.runId, {
      provider,
      removePiBridge: async (value) => { removed.push(value); },
    })).toEqual({ ok: true, released: true, sandboxId: fixture.sandboxId });
    expect(removed).toEqual([sessionFile]);
  });

  test("refuses to tear down a thread with a running turn", async () => {
    const fixture = await runFixture("running");
    const { provider, deleted } = fakeProvider(new Set([fixture.sandboxId]));
    expect(await releaseRunSandbox(fixture.orgId, fixture.runId, { provider })).toEqual({
      ok: false,
      reason: "thread_active",
    });
    expect(deleted).toEqual([]);
    expect(await getThreadSandbox(fixture.runId)).toBe(fixture.sandboxId);
  });

  test("clears a stale mapping only after the provider list proves absence", async () => {
    const fixture = await runFixture();
    const { provider } = fakeProvider(new Set(["unrelated-sandbox"]), true);
    expect(await releaseRunSandbox(fixture.orgId, fixture.runId, { provider })).toEqual({
      ok: true,
      released: true,
      sandboxId: fixture.sandboxId,
    });
    expect(await getThreadSandbox(fixture.runId)).toBeNull();
  });

  test("serializes a same-thread reply that starts while provider delete is in flight", async () => {
    const fixture = await runFixture();
    const deleteStarted = Promise.withResolvers<void>();
    const allowDelete = Promise.withResolvers<void>();
    const live = new Set([fixture.sandboxId]);
    const { provider, deleted } = fakeProvider(live);
    provider.get = async (id) => ({
      id,
      cpu: 1,
      memory: 1,
      process: {} as SandboxHandle["process"],
      fs: {} as SandboxHandle["fs"],
      start: async () => {},
      delete: async () => {
        deleteStarted.resolve();
        await allowDelete.promise;
        deleted.push(id);
        live.delete(id);
      },
      getPreviewLink: async () => ({ url: "https://example.invalid" }),
    });

    const release = releaseRunSandbox(fixture.orgId, fixture.runId, { provider });
    await deleteStarted.promise;

    const replyRunId = crypto.randomUUID();
    createdRuns.add(replyRunId);
    let accepted = false;
    const acceptedReply = acceptRunCommand({
      idempotencyKey: null,
      orgId: fixture.orgId,
      actorId: "user-1",
      run: {
        id: replyRunId,
        prompt: "reply during release",
        model: "mock-model",
        engine: "mock",
        parentRunId: fixture.runId,
        threadId: fixture.runId,
        repos: [],
        memoryScope: "org",
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    }).then((out) => {
      accepted = true;
      return out;
    });

    await Bun.sleep(25);
    expect(accepted).toBe(false);

    allowDelete.resolve();
    expect(await release).toEqual({
      ok: true,
      released: true,
      sandboxId: fixture.sandboxId,
    });
    expect(await acceptedReply).toMatchObject({ status: "created", runId: replyRunId });
    expect(deleted).toEqual([fixture.sandboxId]);
    expect(await getThreadSandbox(fixture.runId)).toBeNull();
  });
});
