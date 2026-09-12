/**
 * Sidebar native-children projection (`GET /api/runs?view=summary`): thread
 * summaries carry a BOUNDED, newest-first, inspect-only projection of the
 * thread's ENGINE-NATIVE child executions, read from the existing execution
 * graph (`agent_executions` mode='native_child') with display titles resolved
 * from canonical `child.started` events. Native children never become runs or
 * threads of their own - the projection only decorates the thread-root view.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db/client";
import { agentExecutions, canonicalEvents, runs } from "../src/db/schema";
import { SIDEBAR_NATIVE_CHILDREN_LIMIT } from "../src/runs/native-children-projection";
import { DEV_ORG_ID } from "../src/seed";
import { json } from "./helpers";

let priorRollout: string | undefined;
beforeEach(() => {
  priorRollout = process.env.EXECUTION_GRAPH_ROLLOUT;
  process.env.EXECUTION_GRAPH_ROLLOUT = "read";
});
afterEach(() => {
  if (priorRollout === undefined) delete process.env.EXECUTION_GRAPH_ROLLOUT;
  else process.env.EXECUTION_GRAPH_ROLLOUT = priorRollout;
});

async function seedThreadRoot(prompt: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(runs).values({
    id,
    orgId: DEV_ORG_ID,
    prompt,
    model: "mock",
    engine: "mock",
    status: "completed",
    parentRunId: null,
    threadId: id,
  });
  return id;
}

interface SummaryRow {
  id: string;
  native_children?: Array<{
    execution_id: string;
    run_id: string;
    provider: string;
    native_session_id: string;
    title: string | null;
    status: string;
    started_at: string | null;
  }>;
  native_children_total?: number;
}

async function summaryFor(threadId: string, query = ""): Promise<SummaryRow | undefined> {
  const { status, body } = await json<{ runs: SummaryRow[] }>(
    `/api/runs?view=summary&limit=100&include_native_children=1${query}`,
  );
  expect(status).toBe(200);
  return body.runs.find((row) => row.id === threadId);
}

describe("sidebar native-children projection", () => {
  test("exposes native children only for an explicit READ-mode sidebar request", async () => {
    const rootId = await seedThreadRoot("rollout-gated native child");
    await db.insert(agentExecutions).values({
      orgId: DEV_ORG_ID,
      runId: rootId,
      sourceKey: "child:rollout:ses_child",
      mode: "native_child",
      provider: "codex",
      nativeSessionId: "ses_child",
      nativeParentSessionId: "ses_parent",
      status: "running",
    });

    for (const mode of ["off", "shadow"] as const) {
      process.env.EXECUTION_GRAPH_ROLLOUT = mode;
      expect((await summaryFor(rootId))?.native_children).toBeUndefined();
    }

    process.env.EXECUTION_GRAPH_ROLLOUT = "read";
    expect((await summaryFor(rootId))?.native_children).toHaveLength(1);
    const withoutExplicitInclude = await json<{ runs: SummaryRow[] }>(
      "/api/runs?view=summary&limit=100",
    );
    expect(
      withoutExplicitInclude.body.runs.find((row) => row.id === rootId)?.native_children,
    ).toBeUndefined();
  });

  test("thread summaries carry bounded newest-first native children with titles", async () => {
    const rootId = await seedThreadRoot("thread with native children");
    const bareId = await seedThreadRoot("thread without native children");

    // 7 native children across the root turn, statuses spanning the enum,
    // started_at staggered so newest-first ordering is deterministic.
    const statuses = [
      "running",
      "completed",
      "failed",
      "queued",
      "waiting",
      "cancelled",
      "completed",
    ] as const;
    const base = Date.parse("2026-09-01T10:00:00Z");
    for (const [index, status] of statuses.entries()) {
      await db.insert(agentExecutions).values({
        orgId: DEV_ORG_ID,
        runId: rootId,
        sourceKey: `child:test:ses_child_${index}`,
        mode: "native_child",
        provider: "opencode",
        nativeSessionId: `ses_child_${index}`,
        nativeParentSessionId: "ses_parent",
        status,
        startedAt: new Date(base + index * 1_000),
      });
    }
    // Canonical spawn titles: child 6 gets a revised title (latest revision
    // wins); child 5 gets a single title; the rest stay untitled.
    await db.insert(canonicalEvents).values([
      {
        eventId: "evt-child-6",
        revision: 0,
        runId: rootId,
        threadId: rootId,
        seq: 1,
        kind: "child.started",
        ts: base,
        identity: { provider: "opencode", nativeSessionId: "ses_parent" },
        body: { kind: "child.started", childId: "ses_child_6", title: "Old title" },
      },
      {
        eventId: "evt-child-6",
        revision: 1,
        runId: rootId,
        threadId: rootId,
        seq: 2,
        kind: "child.started",
        ts: base + 1,
        identity: { provider: "opencode", nativeSessionId: "ses_parent" },
        body: { kind: "child.started", childId: "ses_child_6", title: "Research checkout" },
      },
      {
        eventId: "evt-child-5",
        revision: 0,
        runId: rootId,
        threadId: rootId,
        seq: 3,
        kind: "child.started",
        ts: base + 2,
        identity: { provider: "opencode", nativeSessionId: "ses_parent" },
        body: { kind: "child.started", childId: "ses_child_5", title: "Audit auth" },
      },
    ]);

    const summary = await summaryFor(rootId);
    expect(summary).toBeDefined();
    const children = summary?.native_children ?? [];
    expect(children).toHaveLength(SIDEBAR_NATIVE_CHILDREN_LIMIT);
    expect(summary?.native_children_total).toBe(statuses.length);

    // Newest-first by started_at: children 6..2 survive the bound.
    expect(children.map((child) => child.native_session_id)).toEqual([
      "ses_child_6",
      "ses_child_5",
      "ses_child_4",
      "ses_child_3",
      "ses_child_2",
    ]);
    // Execution-graph statuses pass through untranslated.
    expect(children.map((child) => child.status)).toEqual([
      "completed",
      "cancelled",
      "waiting",
      "queued",
      "failed",
    ]);
    // Titles resolve from canonical child.started; a revised eventId keeps the
    // LATEST revision; untitled children stay null.
    expect(children[0]?.title).toBe("Research checkout");
    expect(children[1]?.title).toBe("Audit auth");
    expect(children[2]?.title).toBeNull();
    // Every row names its owning turn so the UI can deep-link the parent session.
    expect(children.every((child) => child.run_id === rootId)).toBe(true);
    expect(children.every((child) => typeof child.execution_id === "string")).toBe(true);

    // A thread without native children never grows the fields.
    const bare = await summaryFor(bareId);
    expect(bare).toBeDefined();
    expect(bare?.native_children).toBeUndefined();
    expect(bare?.native_children_total).toBeUndefined();

    // The flat `all` view keeps its shape - the projection is thread-view only.
    const flat = await summaryFor(rootId, "&all=1");
    expect(flat).toBeDefined();
    expect(flat?.native_children).toBeUndefined();
  });
});
