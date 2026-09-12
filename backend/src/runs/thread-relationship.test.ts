import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { db } from "../db/client";
import { childThreadBatchItems, commands, providerEvents, runAdmissions, runs, threadRelationships } from "../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { acceptRunCommand } from "../commands/service";
import {
  getThreadRelationship,
  listOrgThreadRelationships,
  listThreadFamilyChildren,
} from "./thread-relationship-repo";
import { createChildSession, gatherChildSessions, getChildSession, listChildSessionEvents, listChildSessions } from "./child-sessions";
import { configureProductChildPump } from "./child-session-pump";
import { acceptProductChildBatch } from "./child-thread-batch-service";
import { claimNextRun } from "../commands/dispatch";
import { acceptThreadFollowup } from "./thread-followups";
import "../index";
import { subscribeOrg } from "./org-signals";

const savedRollout = {
  write: process.env.THREAD_RELATIONSHIPS_WRITE,
  children: process.env.PRODUCT_CHILD_THREADS,
};
let restorePump = () => {};

beforeAll(async () => {
  process.env.THREAD_RELATIONSHIPS_WRITE = "on";
  process.env.PRODUCT_CHILD_THREADS = "on";
  restorePump = configureProductChildPump(async () => null);
});

afterAll(() => {
  restorePump();
  if (savedRollout.write === undefined) delete process.env.THREAD_RELATIONSHIPS_WRITE;
  else process.env.THREAD_RELATIONSHIPS_WRITE = savedRollout.write;
  if (savedRollout.children === undefined) delete process.env.PRODUCT_CHILD_THREADS;
  else process.env.PRODUCT_CHILD_THREADS = savedRollout.children;
});

function input(orgId: string, id: string, key: string, title: string) {
  return {
    idempotencyKey: key,
    orgId,
    actorId: "user-a",
    intent: {
      prompt: "child prompt", model: "gpt-5.6-sol", engine: "codex" as const, parentRunId: null,
      requestedRepos: [], requestedResources: [], attachmentIds: [], memoryScope: "org" as const,
      skillId: null, skillVersion: null, commandName: null, commandProvider: null,
      commandSessionId: null, commandCatalogRevision: null,
    },
    threadRelationship: {
      parentThreadId: "parent", familyThreadId: "parent", kind: "delegated" as const,
      title, sourceRunId: "parent", sourceExecutionId: null,
    },
    run: {
      id, prompt: "child prompt", model: "gpt-5.6-sol", engine: "codex" as const,
      parentRunId: null, threadId: id, repos: [], resolvedResources: [], attachmentIds: [],
      memoryScope: "org" as const, skillId: null, skillVersion: null, skillContentHash: null,
      commandName: null, commandProvider: null, commandSessionId: null, commandCatalogRevision: null,
    },
  };
}

describe("thread relationship acceptance", () => {
  test("commits root run, relationship, command, and admission atomically and fingerprints title", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    await acceptRunCommand({
      ...input(orgId, parentId, `parent-${parentId}`, "Parent"),
      threadRelationship: undefined,
      run: { ...input(orgId, parentId, `parent-${parentId}`, "Parent").run, prompt: "Parent" },
      intent: { ...input(orgId, parentId, `parent-${parentId}`, "Parent").intent, prompt: "Parent" },
    });
    const childInput = input(orgId, childId, `product-child:${parentId}:${parentId}:k`, "Architecture");
    childInput.threadRelationship.parentThreadId = parentId;
    childInput.threadRelationship.familyThreadId = parentId;
    childInput.threadRelationship.sourceRunId = parentId;
    const created = await acceptRunCommand(childInput);
    expect(created.status).toBe("created");
    expect((await getThreadRelationship(orgId, childId))?.parentThreadId).toBe(parentId);
    expect((await db.select().from(runAdmissions)).filter((row) => row.orgId === orgId)).toHaveLength(2);

    const replayInput = input(orgId, crypto.randomUUID(), `product-child:${parentId}:${parentId}:k`, "Architecture");
    Object.assign(replayInput.threadRelationship, { parentThreadId: parentId, familyThreadId: parentId, sourceRunId: parentId });
    const replay = await acceptRunCommand(replayInput);
    expect(replay).toEqual({ status: "replayed", runId: childId });
    const conflictInput = input(orgId, crypto.randomUUID(), `product-child:${parentId}:${parentId}:k`, "Different title");
    Object.assign(conflictInput.threadRelationship, { parentThreadId: parentId, familyThreadId: parentId, sourceRunId: parentId });
    const conflict = await acceptRunCommand(conflictInput);
    expect(conflict.status).toBe("conflict");
  });

  test("singular creation uses a distinct root mailbox and exact title replay fingerprint", async () => {
    const parentId = crypto.randomUUID();
    await acceptRunCommand({
      ...input("org-a", parentId, `parent-${parentId}`, "Parent two"),
      threadRelationship: undefined,
      run: { ...input("org-a", parentId, `parent-${parentId}`, "Parent two").run, prompt: "Parent two" },
      intent: { ...input("org-a", parentId, `parent-${parentId}`, "Parent two").intent, prompt: "Parent two" },
    });
    const base = {
      orgId: "org-a", actorId: "user-a", parentRunId: parentId, threadId: parentId,
      prompt: "Design the architecture", title: "Architecture", engine: "codex" as const,
      model: "gpt-5.6-sol", repos: [], memoryScope: "org" as const, idempotencyKey: "same",
    };
    const created = await createChildSession(base);
    expect(created.status).toBe("created");
    if (created.status === "conflict") throw new Error("unexpected conflict");
    expect(created.child.threadId).not.toBe(parentId);
    expect(created.child.parentRunId).toBe(parentId);
    expect((await createChildSession(base)).status).toBe("replayed");
    expect((await createChildSession({ ...base, title: "Different" })).status).toBe("conflict");

    const sibling = await createChildSession({ ...base, idempotencyKey: "sibling", title: "Sibling" });
    if (sibling.status === "conflict") throw new Error("unexpected sibling conflict");
    const nested = await createChildSession({
      ...base,
      parentRunId: created.child.id,
      threadId: created.child.threadId,
      idempotencyKey: "nested",
      title: "Nested",
    });
    if (nested.status === "conflict") throw new Error("unexpected nested conflict");
    const directIds = (await listChildSessions({ orgId: "org-a", threadId: parentId })).map((child) => child.id);
    expect(directIds).toHaveLength(2);
    expect(new Set(directIds)).toEqual(new Set([created.child.id, sibling.child.id]));
    expect(await getChildSession("org-a", created.child.threadId, sibling.child.id)).toBeNull();
    expect((await getChildSession("org-a", created.child.threadId, nested.child.id))?.id).toBe(nested.child.id);
    await db.update(runs).set({ summary: "x".repeat(5_000) }).where(eq(runs.id, created.child.id));
    const gathered = await gatherChildSessions({ orgId: "org-a", threadId: parentId });
    const gatheredA = gathered.find((child) => child.id === created.child.id) as unknown as {
      result: string;
      resultTruncated: boolean;
      artifacts: unknown[];
      codeHandoffAvailable: boolean;
    };
    expect(gatheredA.result).toHaveLength(4_000);
    expect(gatheredA.resultTruncated).toBe(true);
    expect(gatheredA.artifacts).toEqual([]);
    expect(gatheredA.codeHandoffAvailable).toBe(false);

    await db.insert(providerEvents).values({
      id: `${created.child.id}:initial-event`,
      runId: created.child.id,
      threadId: created.child.threadId,
      seq: 0,
      provider: "codex",
      eventType: "initial.completed",
      payload: "{}",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const followup = await acceptThreadFollowup({
      orgId: "org-a",
      actorId: "user-a",
      threadId: created.child.threadId,
      text: "Latest turn",
      attachmentIds: [],
      idempotencyKey: `latest-turn-${created.child.id}`,
    });
    if (followup.status !== "created") throw new Error(`unexpected follow-up ${followup.status}`);
    await db.insert(providerEvents).values({
      id: `${followup.runId}:latest-event`,
      runId: followup.runId,
      threadId: created.child.threadId,
      seq: 0,
      provider: "codex",
      eventType: "latest.completed",
      payload: "{}",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    const latestEvents = await listChildSessionEvents({
      orgId: "org-a",
      threadId: parentId,
      childRunId: created.child.id,
      cursor: -1,
      limit: 10,
    });
    expect(latestEvents).toMatchObject({
      childRunId: followup.runId,
      cursorRunId: followup.runId,
      eventCount: 1,
      hasMore: false,
      nextCursor: null,
    });
    expect(latestEvents?.events.map((event) => event.eventType)).toEqual(["latest.completed"]);
    const staleCursor = await listChildSessionEvents({
      orgId: "org-a",
      threadId: parentId,
      childRunId: created.child.id,
      cursorRunId: created.child.id,
      cursor: 999,
      limit: 10,
    });
    expect(staleCursor?.events.map((event) => event.eventType)).toEqual(["latest.completed"]);
    const regathered = await gatherChildSessions({ orgId: "org-a", threadId: parentId });
    expect(regathered.find((child) => child.id === created.child.id)).toMatchObject({
      eventCount: 2,
      latestEventTypes: ["latest.completed", "initial.completed"],
    });
  });

  test("lazily repairs an eligible public root accepted while relationship writes were off", async () => {
    const orgId = `org-repair-${crypto.randomUUID()}`;
    const parentId = crypto.randomUUID();
    process.env.THREAD_RELATIONSHIPS_WRITE = "off";
    try {
      await acceptRunCommand({
        ...input(orgId, parentId, `parent-${parentId}`, "Rollback root"),
        threadRelationship: undefined,
        run: { ...input(orgId, parentId, `parent-${parentId}`, "Rollback root").run, prompt: "Rollback root" },
        intent: { ...input(orgId, parentId, `parent-${parentId}`, "Rollback root").intent, prompt: "Rollback root" },
      });
    } finally {
      process.env.THREAD_RELATIONSHIPS_WRITE = "on";
    }
    expect(await getThreadRelationship(orgId, parentId)).toBeNull();
    const signals: unknown[] = [];
    const unsubscribe = subscribeOrg(orgId, (change) => signals.push(change));
    const created = await createChildSession({
      orgId,
      actorId: "user-a",
      parentRunId: parentId,
      threadId: parentId,
      prompt: "Repair before creating me",
      title: "Repaired child",
      engine: "codex",
      model: "gpt-5.6-sol",
      repos: [],
      memoryScope: "org",
      idempotencyKey: "repair-child",
    });
    expect(created.status).toBe("created");
    expect((await getThreadRelationship(orgId, parentId))?.kind).toBe("root");
    if (created.status !== "conflict") {
      expect(signals).toContainEqual({
        type: "thread_relationship",
        action: "created",
        threadId: created.child.threadId,
        familyThreadId: parentId,
      });
    }
    unsubscribe();
  });

  test("merges legacy durable child history without making it product-messageable", async () => {
    const orgId = `org-legacy-merge-${crypto.randomUUID()}`;
    const parentId = crypto.randomUUID();
    await acceptRunCommand({
      ...input(orgId, parentId, `parent-${parentId}`, "Legacy merge parent"),
      threadRelationship: undefined,
      run: { ...input(orgId, parentId, `parent-${parentId}`, "Legacy merge parent").run, prompt: "Legacy merge parent" },
      intent: { ...input(orgId, parentId, `parent-${parentId}`, "Legacy merge parent").intent, prompt: "Legacy merge parent" },
    });
    process.env.PRODUCT_CHILD_THREADS = "off";
    const legacy = await createChildSession({
      orgId,
      actorId: "user-a",
      parentRunId: parentId,
      threadId: parentId,
      prompt: "Legacy deferred work",
      engine: "codex",
      model: "gpt-5.6-sol",
      repos: [],
      memoryScope: "org",
      idempotencyKey: "legacy-before-rollout",
    });
    process.env.PRODUCT_CHILD_THREADS = "on";
    if (legacy.status === "conflict") throw new Error("legacy conflict");
    await db.insert(providerEvents).values({
      id: `${legacy.child.id}:legacy-event`,
      runId: legacy.child.id,
      threadId: parentId,
      seq: 0,
      provider: "codex",
      eventType: "legacy.completed",
      payload: "{}",
    });
    const product = await createChildSession({
      orgId,
      actorId: "user-a",
      parentRunId: parentId,
      threadId: parentId,
      prompt: "Product child work",
      title: "Product child",
      engine: "codex",
      model: "gpt-5.6-sol",
      repos: [],
      memoryScope: "org",
      idempotencyKey: "product-after-rollout",
    });
    if (product.status === "conflict") throw new Error("product conflict");
    const listed = await listChildSessions({ orgId, threadId: parentId, limit: 20 });
    expect(listed.find((child) => child.id === legacy.child.id)).toMatchObject({
      kind: "legacy_child_run",
      messageable: false,
    });
    expect(listed.find((child) => child.id === product.child.id)).toMatchObject({
      kind: "product_thread",
      messageable: true,
    });
    expect(await getChildSession(orgId, parentId, legacy.child.id)).toMatchObject({
      kind: "legacy_child_run",
      messageable: false,
    });
    expect((await listChildSessionEvents({
      orgId,
      threadId: parentId,
      childRunId: legacy.child.id,
      cursor: -1,
    }))?.events.map((event) => event.eventType)).toEqual(["legacy.completed"]);
    expect((await gatherChildSessions({ orgId, threadId: parentId, limit: 20 }))
      .find((child) => child.id === legacy.child.id)).toMatchObject({
        eventCount: 1,
        latestEventTypes: ["legacy.completed"],
      });
  });

  test("singular pumps once on create, never on replay, and pump failure preserves durable acceptance", async () => {
    const orgId = `org-pump-${crypto.randomUUID()}`;
    const parentId = crypto.randomUUID();
    await acceptRunCommand({
      ...input(orgId, parentId, `parent-${parentId}`, "Pump parent"),
      threadRelationship: undefined,
      run: { ...input(orgId, parentId, `parent-${parentId}`, "Pump parent").run, prompt: "Pump parent" },
      intent: { ...input(orgId, parentId, `parent-${parentId}`, "Pump parent").intent, prompt: "Pump parent" },
    });
    const pumped: string[] = [];
    configureProductChildPump(async (threadId) => { pumped.push(threadId); return null; });
    const request = {
      orgId, actorId: "user-a", parentRunId: parentId, threadId: parentId,
      prompt: "One", title: "One", engine: "codex" as const, model: "gpt-5.6-sol",
      repos: [], memoryScope: "org" as const, idempotencyKey: "one",
    };
    const created = await createChildSession(request);
    if (created.status === "conflict") throw new Error("unexpected conflict");
    expect(pumped).toEqual([created.child.threadId]);
    await createChildSession(request);
    expect(pumped).toHaveLength(1);

    const restoreFailurePump = configureProductChildPump(async () => { throw new Error("synthetic pump failure"); });
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      const accepted = await createChildSession({ ...request, idempotencyKey: "pump-fails", title: "Still durable" });
      expect(accepted.status).toBe("created");
      if (accepted.status === "conflict") throw new Error("unexpected conflict");
      const [command] = await db.select().from(commands).where(eq(commands.runId, accepted.child.id));
      expect(command?.state).toBe("queued");
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
      restoreFailurePump();
    }
  });

  test("batch acceptance is ordered, atomic, nullable-actor safe, and conflict detecting", async () => {
    const parentId = crypto.randomUUID();
    await acceptRunCommand({
      ...input("org-batch", parentId, `parent-${parentId}`, "Batch parent"),
      actorId: null,
      threadRelationship: undefined,
      run: { ...input("org-batch", parentId, `parent-${parentId}`, "Batch parent").run, prompt: "Batch parent" },
      intent: { ...input("org-batch", parentId, `parent-${parentId}`, "Batch parent").intent, prompt: "Batch parent" },
    });
    const request = {
      orgId: "org-batch", actorId: null, parentRunId: parentId, parentThreadId: parentId,
      idempotencyKey: " fanout-1 ",
      children: [
        { title: "One", prompt: "Do one", engine: "codex" as const, model: "gpt-5.6-sol" },
        { title: "Two", prompt: "Do two", engine: "codex" as const, model: "gpt-5.6-sol" },
      ],
    };
    const created = await acceptProductChildBatch(request);
    expect(created.status).toBe("created");
    if (created.status === "conflict") throw new Error("unexpected conflict");
    expect(created.children.map((child) => child.title)).toEqual(["One", "Two"]);
    expect(new Set(created.children.map((child) => child.threadId)).size).toBe(2);
    const readiness = process.env.ENGINE_READINESS_CODEX;
    process.env.ENGINE_READINESS_CODEX = "disabled";
    try {
      expect((await acceptProductChildBatch({ ...request, idempotencyKey: "fanout-1" })).status).toBe("replayed");
    } finally {
      if (readiness === undefined) delete process.env.ENGINE_READINESS_CODEX;
      else process.env.ENGINE_READINESS_CODEX = readiness;
    }
    expect((await acceptProductChildBatch({
      ...request,
      children: [{ title: "Changed", prompt: "Do one", engine: "codex" as const, model: "gpt-5.6-sol" }],
    })).status).toBe("conflict");

    await expect(db.transaction(async (tx) => {
      await tx.update(childThreadBatchItems).set({ ordinal: 2 }).where(and(
        eq(childThreadBatchItems.batchId, created.batchId),
        eq(childThreadBatchItems.ordinal, 1),
      ));
      await tx.execute(sql`set constraints all immediate`);
    })).rejects.toThrow();

    await expect(db.transaction(async (tx) => {
      await tx.update(threadRelationships).set({ parentThreadId: created.children[0]!.threadId }).where(and(
        eq(threadRelationships.orgId, request.orgId),
        eq(threadRelationships.threadId, created.children[1]!.threadId),
      ));
      await tx.execute(sql`set constraints all immediate`);
    })).rejects.toThrow();

    const nested = await createChildSession({
      orgId: request.orgId,
      actorId: null,
      parentRunId: created.children[0]!.runId,
      threadId: created.children[0]!.threadId,
      prompt: "Nested cycle probe",
      title: "Nested cycle probe",
      engine: "codex",
      model: "gpt-5.6-sol",
      repos: [],
      memoryScope: "org",
      idempotencyKey: "nested-cycle-probe",
    });
    if (nested.status === "conflict") throw new Error("unexpected nested conflict");
    await expect(db.transaction(async (tx) => {
      await tx.update(threadRelationships).set({ parentThreadId: nested.child.threadId }).where(and(
        eq(threadRelationships.orgId, request.orgId),
        eq(threadRelationships.threadId, created.children[0]!.threadId),
      ));
      await tx.execute(sql`set constraints all immediate`);
    })).rejects.toThrow();
  });

  test("sibling mailboxes claim concurrently while a second same-thread turn stays queued", async () => {
    const orgId = `org-claim-${crypto.randomUUID()}`;
    const parentId = crypto.randomUUID();
    await acceptRunCommand({
      ...input(orgId, parentId, `parent-${parentId}`, "Claim parent"),
      threadRelationship: undefined,
      run: { ...input(orgId, parentId, `parent-${parentId}`, "Claim parent").run, prompt: "Claim parent" },
      intent: { ...input(orgId, parentId, `parent-${parentId}`, "Claim parent").intent, prompt: "Claim parent" },
    });
    const batch = await acceptProductChildBatch({
      orgId, actorId: "user-a", parentRunId: parentId, parentThreadId: parentId, idempotencyKey: "claims",
      children: [
        { title: "A", prompt: "A", engine: "codex", model: "gpt-5.6-sol" },
        { title: "B", prompt: "B", engine: "codex", model: "gpt-5.6-sol" },
      ],
    });
    if (batch.status === "conflict") throw new Error("unexpected conflict");
    const [a, b] = batch.children;
    const followup = await acceptThreadFollowup({
      orgId, actorId: "user-a", threadId: a!.threadId, text: "A follow-up", attachmentIds: [], idempotencyKey: "a-followup",
    });
    expect(followup.status).toBe("created");
    const [claimedA, claimedB] = await Promise.all([claimNextRun(a!.threadId), claimNextRun(b!.threadId)]);
    expect(claimedA).toBe(a!.runId);
    expect(claimedB).toBe(b!.runId);
    expect(await claimNextRun(a!.threadId)).toBeNull();
    const [queuedFollowup] = await db.select({ state: commands.state }).from(commands).where(and(
      eq(commands.runId, followup.status === "created" ? followup.runId : "none"),
      eq(commands.state, "queued"),
    ));
    expect(queuedFollowup?.state).toBe("queued");
  });

  test("paginates organization relationships through a timestamp cursor with the thread-id tie-break", async () => {
    const orgId = `org-relationship-page-${crypto.randomUUID()}`;
    const threadIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const threadId of threadIds) {
      const rootInput = input(orgId, threadId, `root-${threadId}`, `Root ${threadId}`);
      await acceptRunCommand({
        ...rootInput,
        threadRelationship: undefined,
        run: { ...rootInput.run, prompt: `Root ${threadId}` },
        intent: { ...rootInput.intent, prompt: `Root ${threadId}` },
      });
    }
    const createdAt = "2026-08-01 12:00:00.260494+00";
    await db.execute(sql`
      update thread_relationships
      set created_at = ${createdAt}::timestamptz
      where org_id = ${orgId}
    `);

    const expected = threadIds.toSorted((left, right) => right.localeCompare(left));
    const first = await listOrgThreadRelationships({ orgId, limit: 2 });
    expect(first.relationships.map((relationship) => relationship.threadId)).toEqual(expected.slice(0, 2));
    expect(first.hasMore).toBe(true);
    expect(first.next?.createdAtMicros).toMatch(/^[0-9]+$/);
    expect(first.next?.threadId).toBe(expected[1]!);

    const second = await listOrgThreadRelationships({ orgId, limit: 2, after: first.next });
    expect(second.relationships.map((relationship) => relationship.threadId)).toEqual(expected.slice(2));
    expect(second.hasMore).toBe(false);
    expect(second.next).toBeNull();
  });

  test("orders organization relationships by exact microseconds within one millisecond", async () => {
    const orgId = `org-relationship-micros-${crypto.randomUUID()}`;
    const threadIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const threadId of threadIds) {
      const rootInput = input(orgId, threadId, `root-${threadId}`, `Root ${threadId}`);
      await acceptRunCommand({
        ...rootInput,
        threadRelationship: undefined,
        run: { ...rootInput.run, prompt: `Root ${threadId}` },
        intent: { ...rootInput.intent, prompt: `Root ${threadId}` },
      });
    }
    const timestamps = [
      "2026-08-01 12:00:00.000100+00",
      "2026-08-01 12:00:00.000300+00",
      "2026-08-01 12:00:00.000200+00",
    ];
    for (const [index, threadId] of threadIds.entries()) {
      await db.execute(sql`
        update thread_relationships
        set created_at = ${timestamps[index]}::timestamptz
        where org_id = ${orgId} and thread_id = ${threadId}
      `);
    }

    const page = await listOrgThreadRelationships({ orgId, limit: 10 });
    expect(page.relationships.map((relationship) => relationship.threadId)).toEqual([
      threadIds[1]!,
      threadIds[2]!,
      threadIds[0]!,
    ]);
  });

  test("paginates family children through a timestamp cursor with the thread-id tie-break", async () => {
    const orgId = `org-family-page-${crypto.randomUUID()}`;
    const parentId = crypto.randomUUID();
    const rootInput = input(orgId, parentId, `root-${parentId}`, "Family root");
    await acceptRunCommand({
      ...rootInput,
      threadRelationship: undefined,
      run: { ...rootInput.run, prompt: "Family root" },
      intent: { ...rootInput.intent, prompt: "Family root" },
    });
    const childIds: string[] = [];
    for (const title of ["One", "Two", "Three"]) {
      const created = await createChildSession({
        orgId,
        actorId: "user-a",
        parentRunId: parentId,
        threadId: parentId,
        prompt: title,
        title,
        engine: "codex",
        model: "gpt-5.6-sol",
        repos: [],
        memoryScope: "org",
        idempotencyKey: title.toLowerCase(),
      });
      if (created.status === "conflict") throw new Error("unexpected conflict");
      childIds.push(created.child.threadId);
    }
    const createdAt = "2026-08-02 12:00:00.987654+00";
    await db.execute(sql`
      update thread_relationships
      set created_at = ${createdAt}::timestamptz
      where org_id = ${orgId} and family_thread_id = ${parentId}
    `);

    const expected = childIds.toSorted((left, right) => left.localeCompare(right));
    const first = await listThreadFamilyChildren({ orgId, familyThreadId: parentId, limit: 2 });
    expect(first.children.map((child) => child.threadId)).toEqual(expected.slice(0, 2));
    expect(first.hasMore).toBe(true);
    expect(first.next?.createdAtMicros).toMatch(/^[0-9]+$/);
    expect(first.next?.threadId).toBe(expected[1]!);

    const second = await listThreadFamilyChildren({
      orgId,
      familyThreadId: parentId,
      limit: 2,
      after: first.next,
    });
    expect(second.children.map((child) => child.threadId)).toEqual(expected.slice(2));
    expect(second.hasMore).toBe(false);
  });
});
