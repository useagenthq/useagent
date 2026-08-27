import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import {
  acceptRunCommand,
  preflightRunCommandReplay,
} from "../src/commands";
import {
  acceptInternalRunCommand,
  preflightInternalRunCommandReplay,
} from "../src/commands/service";
import { firingKey } from "../src/schedules/fire";
import type { RunCommandInput, RunCommandIntent } from "../src/commands/types";
import { claimNextRun, settleCommandForRun } from "../src/commands/dispatch";
import { completeRun, getRunWithSteps, getThreadForRun } from "../src/runs/repo";
import "./helpers"; // side-effect: imports src/index → migrate + seed
import { createChildSession } from "../src/runs/child-sessions";

// Mailbox primitives for the durable per-session command lane. These drive the
// claim/settle CAS directly (no worker execution) so ordering, one-in-flight,
// idempotency, and cross-thread independence are asserted deterministically.

const ORG = "org-skynet-dev";

/** Enqueue a run.create command (state queued, run queued) without dispatching. */
async function enqueue(threadId: string, parentRunId: string | null): Promise<string> {
  const id = threadId && parentRunId === null ? threadId : crypto.randomUUID();
  const out = await acceptRunCommand({
    idempotencyKey: null,
    orgId: ORG,
    actorId: null,
    run: { id, prompt: "x", model: "claude-opus-5", engine: "mock", parentRunId, threadId },
  });
  expect(out.status).toBe("created");
  return id;
}

/** Retire a thread's commands so they don't pollute a later boot reconcile. */
async function retire(threadId: string): Promise<void> {
  await db.execute(sql`update commands set state='completed' where thread_id=${threadId}`);
}

describe("durable command lane", () => {
  test("trusted internal acceptance persists and replays only within the same origin", async () => {
    const runId = crypto.randomUUID();
    const key = `shared:${crypto.randomUUID()}`;
    const intent = runIntentForTest("internal probe");
    const input = commandForTest(runId, key, intent);
    expect(await acceptInternalRunCommand({
      ...input,
      origin: "internal:e2e",
    })).toMatchObject({ status: "created", runId });
    expect(await preflightInternalRunCommandReplay({
      orgId: ORG,
      idempotencyKey: key,
      intent,
      origin: "internal:e2e",
    })).toEqual({ status: "replayed", runId });
    expect(await preflightRunCommandReplay({
      orgId: ORG,
      idempotencyKey: key,
      intent,
    })).toEqual({ status: "conflict", reason: "origin_mismatch" });
    expect(await preflightInternalRunCommandReplay({
      orgId: ORG,
      idempotencyKey: key,
      intent,
      origin: "internal:canary",
    })).toEqual({ status: "conflict", reason: "origin_mismatch" });
    await retire(runId);

    const productRunId = crypto.randomUUID();
    const productKey = `shared:${crypto.randomUUID()}`;
    await acceptRunCommand(commandForTest(productRunId, productKey, intent));
    expect(await preflightInternalRunCommandReplay({
      orgId: ORG,
      idempotencyKey: productKey,
      intent,
      origin: "internal:e2e",
    })).toEqual({ status: "conflict", reason: "origin_mismatch" });
    await retire(productRunId);
  });

  test("a moving PR head replays before resource resolution", async () => {
    const runId = crypto.randomUUID();
    const key = `moving-pr:${crypto.randomUUID()}`;
    const intent: RunCommandIntent = {
      prompt: "test https://github.com/acme/api/pull/42",
      model: "claude-opus-5",
      engine: "mock",
      parentRunId: null,
      requestedRepos: [],
      attachmentIds: [],
      memoryScope: "org",
      skillId: null,
      skillVersion: null,
      commandName: null,
      commandProvider: null,
      commandSessionId: null,
      commandCatalogRevision: null,
    };
    const input: RunCommandInput = {
      idempotencyKey: key,
      orgId: ORG,
      actorId: null,
      intent,
      run: {
        id: runId,
        prompt: intent.prompt,
        model: intent.model,
        engine: intent.engine,
        parentRunId: null,
        threadId: runId,
        repos: ["acme/api:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        resolvedResources: [],
        memoryScope: "org",
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    };
    expect(await acceptRunCommand(input)).toMatchObject({ status: "created", runId });

    let resolutionCalls = 0;
    const replay = await preflightRunCommandReplay({
      orgId: ORG,
      idempotencyKey: key,
      intent,
    });
    if (!replay) resolutionCalls += 1;
    expect(replay).toEqual({ status: "replayed", runId });
    expect(resolutionCalls).toBe(0);
    await retire(runId);
  });

  test("a lost-response retry succeeds while GitHub is unavailable", async () => {
    const runId = crypto.randomUUID();
    const key = `github-down:${crypto.randomUUID()}`;
    const intent = {
      ...runIntentForTest("inspect https://github.com/acme/api/pull/9"),
    } satisfies RunCommandIntent;
    await acceptRunCommand(commandForTest(runId, key, intent));

    const resolveGithub = async (): Promise<never> => {
      throw new Error("GitHub unavailable");
    };
    const replay = await preflightRunCommandReplay({ orgId: ORG, idempotencyKey: key, intent });
    if (!replay) await resolveGithub();
    expect(replay).toEqual({ status: "replayed", runId });
    await retire(runId);
  });

  test("the same key with a changed raw prompt conflicts before resolution", async () => {
    const runId = crypto.randomUUID();
    const key = `changed-prompt:${crypto.randomUUID()}`;
    const intent = runIntentForTest("inspect the PR");
    await acceptRunCommand(commandForTest(runId, key, intent));
    expect(
      await preflightRunCommandReplay({
        orgId: ORG,
        idempotencyKey: key,
        intent: { ...intent, prompt: "deploy the PR" },
      }),
    ).toEqual({ status: "conflict", reason: "payload_mismatch" });
    await retire(runId);
  });

  test("the same schedule occurrence replays before resource preflight", async () => {
    const runId = crypto.randomUUID();
    const occurrence = new Date("2026-08-21T05:31:42.000Z");
    const key = firingKey(crypto.randomUUID(), "cron", occurrence);
    const intent = {
      ...runIntentForTest("verify the scheduled PR"),
      requestedRepos: ["acme/api"],
      skillId: "skill-1",
      skillVersion: 3,
    } satisfies RunCommandIntent;
    await acceptRunCommand(commandForTest(runId, key, intent));
    expect(
      await preflightRunCommandReplay({ orgId: ORG, idempotencyKey: key, intent }),
    ).toEqual({ status: "replayed", runId });
    await retire(runId);
  });

  test("a child-session replay does not reauthorize newly unavailable inherited resources", async () => {
    const parentId = crypto.randomUUID();
    await acceptRunCommand(commandForTest(parentId, `parent:${crypto.randomUUID()}`, runIntentForTest("parent")));
    const childInput = {
      orgId: ORG,
      actorId: null,
      parentRunId: parentId,
      threadId: parentId,
      prompt: "delegate once",
      engine: "mock" as const,
      model: "claude-opus-5",
      repos: [],
      memoryScope: "org" as const,
      idempotencyKey: `child:${crypto.randomUUID()}`,
    };
    const first = await createChildSession(childInput);
    expect(first.status).toBe("created");
    if (first.status === "conflict") throw new Error("unexpected conflict");

    await db.update(runs).set({
      repos: ["acme/api:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      resolvedResources: [{
        kind: "code.change",
        provider: "github",
        locator: {
          type: "github.pull_request",
          repository: "acme/api",
          number: 42,
          revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        capabilities: ["change.read"],
        provenance: [{
          source: "user_text",
          channel: "web",
          raw: "https://github.com/acme/api/pull/42",
          start: 0,
          end: 39,
        }],
      }],
    }).where(eq(runs.id, parentId));

    const replay = await createChildSession(childInput);
    expect(replay.status).toBe("replayed");
    if (replay.status === "conflict") throw new Error("unexpected conflict");
    expect(replay.child.id).toBe(first.child.id);
    await retire(parentId);
    await retire(first.child.id);
  });

  test("a child session inherits its parent's exact trusted internal origin", async () => {
    const parentId = crypto.randomUUID();
    await acceptInternalRunCommand({
      ...commandForTest(
        parentId,
        `internal-parent:${crypto.randomUUID()}`,
        runIntentForTest("internal parent"),
      ),
      origin: "internal:release-parity",
    });
    const child = await createChildSession({
      orgId: ORG,
      actorId: null,
      parentRunId: parentId,
      threadId: parentId,
      prompt: "internal child",
      engine: "mock",
      model: "claude-opus-5",
      repos: [],
      memoryScope: "org",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(child.status).toBe("created");
    if (child.status === "conflict") throw new Error("unexpected conflict");
    const [row] = await db
      .select({ origin: runs.origin })
      .from(runs)
      .where(eq(runs.id, child.child.id))
      .limit(1);
    expect(row?.origin).toBe("internal:release-parity");
    await retire(parentId);
    await retire(child.child.id);
  });

  test("the thread projection marks gateway child sessions, and only them", async () => {
    const parentId = crypto.randomUUID();
    await acceptRunCommand(
      commandForTest(parentId, `parent:${crypto.randomUUID()}`, runIntentForTest("root turn")),
    );
    const child = await createChildSession({
      orgId: ORG,
      actorId: null,
      parentRunId: parentId,
      threadId: parentId,
      prompt: "delegated audit",
      engine: "mock",
      model: "claude-opus-5",
      repos: [],
      memoryScope: "org",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(child.status).toBe("created");
    if (child.status === "conflict") throw new Error("unexpected conflict");
    // An ordinary REPLY also carries parent_run_id - it must NOT be marked.
    const replyId = crypto.randomUUID();
    const replyInput = commandForTest(replyId, `reply:${crypto.randomUUID()}`, {
      ...runIntentForTest("plain reply"),
      parentRunId: parentId,
    });
    await acceptRunCommand({
      ...replyInput,
      run: { ...replyInput.run, threadId: parentId },
    });

    const thread = await getThreadForRun(ORG, parentId);
    expect(thread).not.toBeNull();
    const byId = new Map(thread!.map((r) => [r.id, r]));
    expect(byId.get(parentId)?.child_session).toBe(false);
    expect(byId.get(child.child.id)?.child_session).toBe(true);
    expect(byId.get(replyId)?.child_session).toBe(false);
    // The single-run projection (the thread SSE `run` frame) carries the same mark.
    expect((await getRunWithSteps(ORG, child.child.id))?.child_session).toBe(true);

    await retire(parentId);
    await retire(child.child.id);
    await retire(replyId);
  });

  test("replays an accepted key even after provider readiness changes", async () => {
    const threadId = crypto.randomUUID();
    const idempotencyKey = `replay-after-health-change:${crypto.randomUUID()}`;
    const input = {
      idempotencyKey,
      orgId: ORG,
      actorId: null,
      run: {
        id: threadId,
        prompt: "durable replay",
        model: "gpt-5.6-sol",
        engine: "codex" as const,
        parentRunId: null,
        threadId,
        repos: [],
        memoryScope: "org" as const,
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    };

    expect(await acceptRunCommand(input)).toMatchObject({ status: "created", runId: threadId });
    const previous = process.env.PROVIDER_HEALTH_OPENAI;
    process.env.PROVIDER_HEALTH_OPENAI = "failed";
    try {
      expect(await acceptRunCommand(input)).toEqual({ status: "replayed", runId: threadId });
    } finally {
      if (previous === undefined) delete process.env.PROVIDER_HEALTH_OPENAI;
      else process.env.PROVIDER_HEALTH_OPENAI = previous;
      await retire(threadId);
    }
  });

  test("per-thread: strict order + at most one command in flight", async () => {
    const T = crypto.randomUUID();
    await enqueue(T, null); // root A, run id === thread id === T
    const B = await enqueue(T, T); // reply

    // Head A dispatches; a second claim is refused while A is in flight.
    expect(await claimNextRun(T)).toBe(T);
    expect(await claimNextRun(T)).toBeNull();

    // A finishes → its command settles → the NEXT turn (B) can dispatch, in order.
    expect(await completeRun(T, "completed", "done", 1)).toBe(true);
    expect(await completeRun(`missing-${T}`, "completed", "done", 1)).toBe(false);
    expect((await settleCommandForRun(T)).status).toBe("completed");
    expect(await claimNextRun(T)).toBe(B);
    expect(await claimNextRun(T)).toBeNull(); // B now in flight

    await retire(T);
  });

  test("concurrent claims dispatch a command AT MOST once (idempotent CAS)", async () => {
    const T = crypto.randomUUID();
    await enqueue(T, null);

    const [r1, r2] = await Promise.all([claimNextRun(T), claimNextRun(T)]);
    expect([r1, r2].filter((x) => x === T)).toHaveLength(1);
    expect([r1, r2].filter((x) => x === null)).toHaveLength(1);

    await retire(T);
  });

  test("different threads dispatch concurrently (queues never serialize)", async () => {
    const T1 = crypto.randomUUID();
    const T2 = crypto.randomUUID();
    await enqueue(T1, null);
    await enqueue(T2, null);

    const [r1, r2] = await Promise.all([claimNextRun(T1), claimNextRun(T2)]);
    expect(r1).toBe(T1);
    expect(r2).toBe(T2);

    await retire(T1);
    await retire(T2);
  });

  test("settleCommandForRun requeues a run whose worker never started", async () => {
    const T = crypto.randomUUID();
    await enqueue(T, null);
    expect(await claimNextRun(T)).toBe(T); // dispatched, but run stays queued

    // Worker died before setting the run running → the command requeues.
    expect((await settleCommandForRun(T)).status).toBe("requeued");
    // ...so it can be claimed again (re-dispatch).
    expect(await claimNextRun(T)).toBe(T);

    await retire(T);
  });
});

function runIntentForTest(prompt: string): RunCommandIntent {
  return {
    prompt,
    model: "claude-opus-5",
    engine: "mock",
    parentRunId: null,
    requestedRepos: [],
    attachmentIds: [],
    memoryScope: "org",
    skillId: null,
    skillVersion: null,
    commandName: null,
    commandProvider: null,
    commandSessionId: null,
    commandCatalogRevision: null,
  };
}

function commandForTest(
  runId: string,
  idempotencyKey: string,
  intent: RunCommandIntent,
): RunCommandInput {
  return {
    idempotencyKey,
    orgId: ORG,
    actorId: null,
    intent,
    run: {
      id: runId,
      prompt: intent.prompt,
      model: intent.model,
      engine: intent.engine,
      parentRunId: intent.parentRunId,
      threadId: runId,
      repos: [...intent.requestedRepos],
      memoryScope: intent.memoryScope,
      skillId: intent.skillId,
      skillVersion: intent.skillVersion,
      skillContentHash: null,
      commandName: intent.commandName,
      commandProvider: intent.commandProvider,
      commandSessionId: intent.commandSessionId,
      commandCatalogRevision: intent.commandCatalogRevision,
    },
  };
}
