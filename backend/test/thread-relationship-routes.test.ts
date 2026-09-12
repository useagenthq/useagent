import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createOrgSession, json, uid } from "./helpers";
import { createChildSession } from "../src/runs/child-sessions";
import { getRunForOrg } from "../src/runs/repo";
import { db } from "../src/db/client";
import { agentExecutions, finishedWorkReceipts, runs, threadRelationships } from "../src/db/schema";
import { CANONICAL_SCHEMA_VERSION } from "@useagent/agent-harness/canonical";
import { persistCanonicalEvents } from "../src/runs/canonical-events";
import { createArtifactRecord } from "../src/artifacts/repo";
import { and, eq, sql } from "drizzle-orm";

const rolloutEnv = new Map<string, string | undefined>();
beforeAll(() => {
  for (const key of ["THREAD_RELATIONSHIPS_WRITE", "THREAD_RELATIONSHIPS_READ", "PRODUCT_CHILD_THREADS", "PRODUCT_CHILD_CANARY_ORG_IDS"]) {
    rolloutEnv.set(key, process.env[key]);
  }
  process.env.THREAD_RELATIONSHIPS_WRITE = "on";
  process.env.THREAD_RELATIONSHIPS_READ = "read";
  process.env.PRODUCT_CHILD_THREADS = "on";
});

afterAll(() => {
  for (const [key, value] of rolloutEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("thread relationship routes", () => {
  test("serve bounded tenant-safe family data and share follow-up acceptance semantics", async () => {
    const owner = await createOrgSession("thread-family-owner");
    const stranger = await createOrgSession("thread-family-stranger");
    const root = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: owner.cookies,
      headers: { "Idempotency-Key": uid("root") },
      body: {
        prompt: "Use https://example.com as context for this root",
        engine: "mock",
        memory_scope: "personal",
      },
    });
    expect(root.status).toBe(201);
    const parent = await getRunForOrg(owner.orgId, root.body.id);
    if (!parent) throw new Error("root run missing");

    const makeChild = (title: string, key: string) => createChildSession({
      orgId: owner.orgId,
      actorId: parent.userId,
      parentRunId: parent.id,
      threadId: parent.threadId,
      title,
      prompt: `${title} task`,
      engine: parent.engine,
      model: parent.model,
      repos: parent.repos,
      memoryScope: parent.memoryScope,
      idempotencyKey: key,
    });
    const childA = await makeChild("Child A", "a");
    const childB = await makeChild("Child B", "b");
    if (childA.status === "conflict" || childB.status === "conflict") throw new Error("child conflict");
    await db.update(runs).set({
      summary: "S".repeat(1_100),
      durationMs: 1_250,
    }).where(eq(runs.id, childA.child.id));

    const relationship = await json<{
      relationship: {
        thread_id: string;
        status: string;
        latest_summary: string | null;
        latest_duration_ms: number | null;
      };
    }>(
      `/api/threads/${childA.child.threadId}/relationship`,
      { cookies: owner.cookies },
    );
    expect(relationship.status).toBe(200);
    expect(relationship.body.relationship.thread_id).toBe(childA.child.threadId);
    expect(relationship.body.relationship.latest_summary).toHaveLength(1_000);
    expect(relationship.body.relationship.latest_summary?.endsWith("…")).toBe(true);
    expect(relationship.body.relationship.latest_duration_ms).toBe(1_250);

    const family = await json<{ children: Array<{ thread_id: string }>; has_more: boolean }>(
      `/api/threads/${parent.threadId}/children?limit=100`,
      { cookies: owner.cookies },
    );
    expect(family.status).toBe(200);
    expect(new Set(family.body.children.map((child) => child.thread_id))).toEqual(
      new Set([childA.child.threadId, childB.child.threadId]),
    );
    const index = await json<{ relationships: Array<{ thread_id: string }>; has_more: boolean }>(
      "/api/threads/relationships?limit=200",
      { cookies: owner.cookies },
    );
    expect(index.status).toBe(200);
    expect(index.body.relationships.some((item) => item.thread_id === childA.child.threadId)).toBe(true);
    const forgedCursor = Buffer.from(
      JSON.stringify([owner.orgId, "04 DecFoo 1995", childA.child.threadId]),
    ).toString("base64url");
    expect((await json(
      `/api/threads/relationships?cursor=${encodeURIComponent(forgedCursor)}`,
      { cookies: owner.cookies },
    )).status).toBe(400);
    const overflowingCursor = Buffer.from(
      JSON.stringify([owner.orgId, "99999999999999999999", childA.child.threadId]),
    ).toString("base64url");
    expect((await json(
      `/api/threads/relationships?cursor=${encodeURIComponent(overflowingCursor)}`,
      { cookies: owner.cookies },
    )).status).toBe(400);

    expect((await json(`/api/threads/${childA.child.threadId}/relationship`, { cookies: stranger.cookies })).status).toBe(404);
    expect((await json(`/api/threads/${parent.threadId}/children`, { cookies: stranger.cookies })).status).toBe(404);

    const [execution] = await db.insert(agentExecutions).values({
      orgId: owner.orgId,
      runId: childA.child.id,
      sourceKey: `native:${crypto.randomUUID()}`,
      mode: "native_child",
      provider: "mock-provider",
      nativeSessionId: `native-${crypto.randomUUID()}`,
      status: "completed",
    }).returning();
    const [rootExecution] = await db.insert(agentExecutions).values({
      orgId: owner.orgId,
      runId: childA.child.id,
      sourceKey: `root:${crypto.randomUUID()}`,
      mode: "root",
      provider: "mock-provider",
      nativeSessionId: `root-${crypto.randomUUID()}`,
      status: "completed",
    }).returning();
    expect((await json(`/api/threads/${childA.child.threadId}/continue-native-child`, {
      method: "POST",
      cookies: owner.cookies,
      body: { executionId: rootExecution!.id, title: "Invalid root", idempotencyKey: "continue-root" },
    })).status).toBe(404);
    await db.insert(agentExecutions).values({
      orgId: owner.orgId,
      runId: childA.child.id,
      sourceKey: `native:${crypto.randomUUID()}`,
      mode: "native_child",
      provider: "mock-provider",
      nativeSessionId: "other-native-session",
      status: "completed",
    });
    await persistCanonicalEvents([
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: `${childA.child.id}:selected`,
        seq: 1,
        runId: childA.child.id,
        threadId: childA.child.threadId,
        ts: 1,
        identity: { provider: "mock-provider", nativeSessionId: execution!.nativeSessionId! },
        kind: "message.completed",
        messageId: "selected-message",
        text: "selected execution only",
      },
      {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        eventId: `${childA.child.id}:other`,
        seq: 2,
        runId: childA.child.id,
        threadId: childA.child.threadId,
        ts: 2,
        identity: { provider: "mock-provider", nativeSessionId: "other-native-session" },
        kind: "message.completed",
        messageId: "other-message",
        text: "must not leak from another execution",
      },
    ]);
    const continued = await json<{
      thread_id: string;
      replayed: boolean;
      source_event_ref: string;
    }>(
      `/api/threads/${childA.child.threadId}/continue-native-child`,
      {
        method: "POST",
        cookies: owner.cookies,
        body: { executionId: execution!.id, title: "Continued native work", idempotencyKey: "continue-a" },
      },
    );
    expect(continued.status).toBe(201);
    expect(continued.body.replayed).toBe(false);
    expect(continued.body.source_event_ref).toContain(`/executions/${execution!.id}/canonical-events`);
    const continuedRun = await getRunForOrg(owner.orgId, continued.body.thread_id);
    expect(continuedRun?.prompt).toContain("selected execution only");
    expect(continuedRun?.prompt).not.toContain("must not leak from another execution");
    const continuedRelationship = await json<{ relationship: { kind: string; parent_thread_id: string } }>(
      `/api/threads/${continued.body.thread_id}/relationship`,
      { cookies: owner.cookies },
    );
    expect(continuedRelationship.body.relationship).toMatchObject({
      kind: "continued_from_native",
      parent_thread_id: childA.child.threadId,
    });
    await expect(db.transaction(async (tx) => {
      await tx.update(threadRelationships).set({ sourceExecutionId: rootExecution!.id }).where(and(
        eq(threadRelationships.orgId, owner.orgId),
        eq(threadRelationships.threadId, continued.body.thread_id),
      ));
      await tx.execute(sql`set constraints all immediate`);
    })).rejects.toThrow();

    const childFallback = await makeChild("Child fallback", "fallback");
    if (childFallback.status === "conflict") throw new Error("child fallback conflict");
    await db.update(runs).set({ summary: "durable child result without canonical transcript" })
      .where(eq(runs.id, childFallback.child.id));
    const artifact = await createArtifactRecord({
      orgId: owner.orgId,
      userId: parent.userId,
      runId: childFallback.child.id,
      threadId: childFallback.child.threadId,
      sourcePath: "/result/report.pdf",
      name: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 12,
      sha256: "a".repeat(64),
      storageKey: "test/report.pdf",
    });
    await db.insert(finishedWorkReceipts).values({
      orgId: owner.orgId,
      runId: childFallback.child.id,
      threadId: childFallback.child.threadId,
      kind: "repository_changed",
      authority: "github_publication",
      sourceKey: "github:test-fallback",
      metadata: {
        commitSha: "b".repeat(40),
        pullRequestUrl: "https://github.com/useagenthq/useagent/pull/42",
      },
    });
    const [fallbackExecution] = await db.insert(agentExecutions).values({
      orgId: owner.orgId,
      runId: childFallback.child.id,
      sourceKey: `native:${crypto.randomUUID()}`,
      mode: "native_child",
      provider: "mock-provider",
      nativeSessionId: `fallback-${crypto.randomUUID()}`,
      status: "completed",
    }).returning();
    const fallbackContinued = await json<{ thread_id: string }>(
      `/api/threads/${childFallback.child.threadId}/continue-native-child`,
      {
        method: "POST",
        cookies: owner.cookies,
        body: { executionId: fallbackExecution!.id, title: "Fallback context", idempotencyKey: "continue-fallback" },
      },
    );
    expect(fallbackContinued.status).toBe(201);
    const fallbackRun = await getRunForOrg(owner.orgId, fallbackContinued.body.thread_id);
    expect(fallbackRun?.prompt).toContain("durable child result without canonical transcript");
    expect(fallbackRun?.prompt).toContain(artifact.row.id);
    expect(fallbackRun?.prompt).toContain("b".repeat(40));
    expect(fallbackRun?.prompt).not.toContain("storageKey");

    const prompt = "same semantic follow-up";
    const ordinary = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: owner.cookies,
      headers: { "Idempotency-Key": "ordinary-followup" },
      body: { prompt, parent_run_id: childA.child.id },
    });
    const childRoute = await json<{ id: string }>(`/api/threads/${childB.child.threadId}/messages`, {
      method: "POST",
      cookies: owner.cookies,
      headers: { "Idempotency-Key": "child-followup" },
      body: { text: prompt },
    });
    expect(ordinary.status).toBe(201);
    expect(childRoute.status).toBe(201);
    const [ordinaryRun, childRouteRun] = await Promise.all([
      getRunForOrg(owner.orgId, ordinary.body.id),
      getRunForOrg(owner.orgId, childRoute.body.id),
    ]);
    expect(ordinaryRun && childRouteRun).toBeTruthy();
    expect({
      engine: ordinaryRun!.engine,
      model: ordinaryRun!.model,
      repos: ordinaryRun!.repos,
      resources: ordinaryRun!.resolvedResources,
      memory: ordinaryRun!.memoryScope,
      skill: [ordinaryRun!.skillId, ordinaryRun!.skillVersion, ordinaryRun!.skillContentHash],
      origin: ordinaryRun!.origin,
    }).toEqual({
      engine: childRouteRun!.engine,
      model: childRouteRun!.model,
      repos: childRouteRun!.repos,
      resources: childRouteRun!.resolvedResources,
      memory: childRouteRun!.memoryScope,
      skill: [childRouteRun!.skillId, childRouteRun!.skillVersion, childRouteRun!.skillContentHash],
      origin: childRouteRun!.origin,
    });

    const replay = await json<{ id: string }>(`/api/threads/${childB.child.threadId}/messages`, {
      method: "POST",
      cookies: owner.cookies,
      headers: { "Idempotency-Key": "child-followup" },
      body: { text: prompt },
    });
    expect(replay).toEqual({ status: 200, body: { id: childRoute.body.id } });
    expect((await json(`/api/threads/${childB.child.threadId}/messages`, {
      method: "POST",
      cookies: stranger.cookies,
      headers: { "Idempotency-Key": "foreign" },
      body: { text: "foreign" },
    })).status).toBe(404);
  });

  test("never exposes or creates a public relationship for an internal root", async () => {
    const owner = await createOrgSession("thread-family-internal-boundary");
    const internalId = crypto.randomUUID();
    await db.insert(runs).values({
      id: internalId,
      orgId: owner.orgId,
      prompt: "private canary",
      model: "mock",
      engine: "mock",
      status: "completed",
      threadId: internalId,
      origin: "internal:canary",
    });
    await expect((async () => {
      await db.insert(threadRelationships).values({
        orgId: owner.orgId,
        threadId: internalId,
        parentThreadId: null,
        familyThreadId: internalId,
        kind: "root",
        title: "private canary",
        sourceRunId: internalId,
        sourceExecutionId: null,
      }).returning();
    })()).rejects.toThrow();
    expect((await json(`/api/threads/${internalId}/relationship`, { cookies: owner.cookies })).status).toBe(404);
    expect((await json(`/api/threads/${internalId}/children`, { cookies: owner.cookies })).status).toBe(404);
  });

  test("canary allowlist enables product child reads and composer for one org only", async () => {
    const allowed = await createOrgSession("thread-canary-allowed");
    const denied = await createOrgSession("thread-canary-denied");
    process.env.THREAD_RELATIONSHIPS_WRITE = "shadow";
    process.env.THREAD_RELATIONSHIPS_READ = "off";
    process.env.PRODUCT_CHILD_THREADS = "off";
    process.env.PRODUCT_CHILD_CANARY_ORG_IDS = allowed.orgId;
    try {
      const makeRoot = (cookies: string) => json<{ id: string }>("/api/runs", {
        method: "POST",
        cookies,
        headers: { "Idempotency-Key": uid("canary-root") },
        body: { prompt: "Canary root", engine: "mock" },
      });
      const allowedRoot = await makeRoot(allowed.cookies);
      const deniedRoot = await makeRoot(denied.cookies);
      const allowedRun = await getRunForOrg(allowed.orgId, allowedRoot.body.id);
      const deniedRun = await getRunForOrg(denied.orgId, deniedRoot.body.id);
      if (!allowedRun || !deniedRun) throw new Error("canary roots missing");
      const allowedChild = await createChildSession({
        orgId: allowed.orgId,
        actorId: allowedRun.userId,
        parentRunId: allowedRun.id,
        threadId: allowedRun.threadId,
        prompt: "Allowed product child",
        title: "Allowed product child",
        engine: allowedRun.engine,
        model: allowedRun.model,
        repos: [],
        memoryScope: allowedRun.memoryScope,
        idempotencyKey: "allowed-child",
      });
      const deniedChild = await createChildSession({
        orgId: denied.orgId,
        actorId: deniedRun.userId,
        parentRunId: deniedRun.id,
        threadId: deniedRun.threadId,
        prompt: "Denied legacy child",
        title: "Denied legacy child",
        engine: deniedRun.engine,
        model: deniedRun.model,
        repos: [],
        memoryScope: deniedRun.memoryScope,
        idempotencyKey: "denied-child",
      });
      if (allowedChild.status === "conflict" || deniedChild.status === "conflict") throw new Error("canary child conflict");
      expect(allowedChild.child.kind).toBe("product_thread");
      expect(deniedChild.child.kind).toBe("legacy_child_run");
      expect((await json(`/api/threads/${allowedRun.threadId}/children`, { cookies: allowed.cookies })).status).toBe(200);
      expect((await json(`/api/threads/${deniedRun.threadId}/children`, { cookies: denied.cookies })).status).toBe(404);
      expect((await json(`/api/threads/${allowedChild.child.threadId}/messages`, {
        method: "POST",
        cookies: allowed.cookies,
        headers: { "Idempotency-Key": "canary-followup" },
        body: { text: "Allowed follow-up" },
      })).status).toBe(201);
      expect((await json(`/api/threads/${deniedRun.threadId}/messages`, {
        method: "POST",
        cookies: denied.cookies,
        headers: { "Idempotency-Key": "denied-followup" },
        body: { text: "Denied follow-up" },
      })).status).toBe(404);
    } finally {
      process.env.THREAD_RELATIONSHIPS_WRITE = "on";
      process.env.THREAD_RELATIONSHIPS_READ = "read";
      process.env.PRODUCT_CHILD_THREADS = "on";
      delete process.env.PRODUCT_CHILD_CANARY_ORG_IDS;
    }
  });
});
