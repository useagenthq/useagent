import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import {
  executionGraphPendingObservations,
  providerEvents,
  runs,
} from "../src/db/schema";
import {
  executionGraphSealBlockers,
  executionGraphStructureHash,
  executionGraphRecoveryDiagnostics,
  EXECUTION_GRAPH_RECOVERY_MAX_ATTEMPTS,
  markExecutionGraphObservationApplied,
  recordExecutionGraphRecoveryAttempt,
  stageExecutionGraphObservation,
  unresolvedExecutionGraphObservationsForParent,
} from "../src/runs/execution-graph-pending-repo";

const databaseName = `useagent_execution_pending_${crypto.randomUUID().replaceAll("-", "")}`;
const adminUrl = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { max: 1 });
await admin.unsafe(`create database "${databaseName}"`);
const client = postgres(testUrl.toString(), { max: 2 });
const testDb = drizzle(client, { schema });
await migrate(testDb, { migrationsFolder: `${import.meta.dir}/../drizzle` });

afterAll(async () => {
  await client.end();
  await admin.unsafe(`drop database if exists "${databaseName}"`);
  await admin.end();
});

async function seedRun(orgId: string): Promise<string> {
  const runId = crypto.randomUUID();
  await testDb.insert(runs).values({
    id: runId,
    orgId,
    prompt: "pending recovery",
    model: "test/model",
    engine: "opencode",
    status: "running",
    threadId: runId,
  });
  return runId;
}

async function sourceEvent(input: {
  readonly runId: string;
  readonly id: string;
  readonly provider?: string;
  readonly seq: number;
}): Promise<void> {
  await testDb.insert(providerEvents).values({
    id: input.id,
    runId: input.runId,
    threadId: input.runId,
    seq: input.seq,
    provider: input.provider ?? "t3",
    eventType: "t3.activity.task.started",
  }).onConflictDoUpdate({
    target: providerEvents.id,
    set: { seq: input.seq, provider: input.provider ?? "t3" },
  });
}

describe("execution graph pending observation repository", () => {
  test("keeps first-deferral order while the latest unapplied revision owns classification", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    const eventId = `${runId}:revised`;
    await sourceEvent({ runId, id: eventId, seq: 1 });
    const first = await stageExecutionGraphObservation({
      orgId,
      runId,
      provider: "t3",
      providerEventId: eventId,
      deliverySeq: 1,
      structure: {
        kind: "spawn",
        nativeParentSessionId: "parent-old",
        nativeChildSessionId: "child",
        relevant: true,
        executionRequired: true,
      },
    }, testDb);
    expect(first.outcome).toBe("inserted");

    await sourceEvent({ runId, id: eventId, seq: 2 });
    const revised = await stageExecutionGraphObservation({
      orgId,
      runId,
      provider: "t3",
      providerEventId: eventId,
      deliverySeq: 2,
      structure: {
        kind: "control",
        nativeParentSessionId: "parent-new",
        nativeChildSessionId: "child-new",
        relevant: true,
        executionRequired: false,
      },
    }, testDb);
    expect(revised.outcome).toBe("updated");
    expect(revised.row).toMatchObject({
      firstDeferredDeliverySeq: 1,
      latestProviderEventSeq: 2,
      latestObservationKind: "control",
      latestNativeParentSessionId: "parent-new",
      latestNativeChildSessionId: "child-new",
      latestExecutionRequired: false,
    });
    expect((await stageExecutionGraphObservation({
      orgId,
      runId,
      provider: "t3",
      providerEventId: eventId,
      deliverySeq: 1,
      structure: {
        kind: "spawn",
        nativeParentSessionId: "parent-old",
        nativeChildSessionId: "child",
        relevant: true,
        executionRequired: true,
      },
    }, testDb)).outcome).toBe("stale");
    expect(await testDb.select().from(executionGraphPendingObservations).where(
      eq(executionGraphPendingObservations.providerEventId, eventId),
    )).toHaveLength(1);
  });

  test("reactivates an unapplied irrelevant source but never rewrites applied structure", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    const eventId = `${runId}:applied`;
    await sourceEvent({ runId, id: eventId, seq: 1 });
    const irrelevant = await stageExecutionGraphObservation({
      orgId,
      runId,
      provider: "t3",
      providerEventId: eventId,
      deliverySeq: 1,
      structure: {
        kind: "spawn",
        nativeParentSessionId: "parent",
        nativeChildSessionId: "child",
        relevant: false,
        executionRequired: true,
      },
    }, testDb);
    expect(irrelevant.row.resolutionReason).toBe("source_irrelevant");

    await sourceEvent({ runId, id: eventId, seq: 2 });
    const structure = {
      kind: "spawn" as const,
      nativeParentSessionId: "parent",
      nativeChildSessionId: "child",
      relevant: true,
      executionRequired: true,
    };
    const reactivated = await stageExecutionGraphObservation({
      orgId,
      runId,
      provider: "t3",
      providerEventId: eventId,
      deliverySeq: 2,
      structure,
    }, testDb);
    expect(reactivated.row).toMatchObject({ resolvedAt: null, resolutionReason: null });
    const applied = await markExecutionGraphObservationApplied({
      id: reactivated.row.id,
      expectedProviderEventSeq: 2,
      structure,
      reason: "applied",
    }, testDb);
    expect(applied.appliedStructureHash).toBe(executionGraphStructureHash(structure));

    await sourceEvent({ runId, id: eventId, seq: 3 });
    expect((await stageExecutionGraphObservation({
      orgId,
      runId,
      provider: "t3",
      providerEventId: eventId,
      deliverySeq: 3,
      structure,
    }, testDb)).outcome).toBe("applied_match");

    await sourceEvent({ runId, id: eventId, seq: 4 });
    const mismatch = await stageExecutionGraphObservation({
      orgId,
      runId,
      provider: "t3",
      providerEventId: eventId,
      deliverySeq: 4,
      structure: { ...structure, nativeParentSessionId: "different-parent" },
    }, testDb);
    expect(mismatch.outcome).toBe("structural_mismatch");
    expect(mismatch.row).toMatchObject({
      appliedStructureHash: executionGraphStructureHash(structure),
      structuralMismatchSourceSeq: 4,
      structuralMismatchCode: "applied_structure_changed",
    });
    expect(await executionGraphSealBlockers(orgId, runId, testDb)).toEqual([
      expect.objectContaining({ id: mismatch.row.id }),
    ]);
  });

  test("orders exact-key wakeups and tracks bounded recovery attempts", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    for (const seq of [2, 1]) {
      const eventId = `${runId}:parent:${seq}`;
      await sourceEvent({ runId, id: eventId, seq });
      await stageExecutionGraphObservation({
        orgId,
        runId,
        provider: "t3",
        providerEventId: eventId,
        deliverySeq: seq,
        structure: {
          kind: "spawn",
          nativeParentSessionId: "late-parent",
          nativeChildSessionId: `child-${seq}`,
          relevant: true,
          executionRequired: true,
        },
      }, testDb);
    }
    const rows = await unresolvedExecutionGraphObservationsForParent({
      orgId,
      runId,
      provider: "t3",
      nativeSessionId: "late-parent",
      limit: 10,
    }, testDb);
    expect(rows.map((row) => row.firstDeferredDeliverySeq)).toEqual([1, 2]);
    await recordExecutionGraphRecoveryAttempt(rows[0]!.id, testDb);
    const [attempted] = await testDb.select().from(executionGraphPendingObservations).where(
      eq(executionGraphPendingObservations.id, rows[0]!.id),
    );
    expect(attempted).toMatchObject({ attemptCount: 1 });
    expect(attempted?.lastAttemptAt).toBeInstanceOf(Date);
  });

  test("database constraints reject cross-run, cross-org, and wrong-provider pointers", async () => {
    const orgA = `org-${crypto.randomUUID()}`;
    const orgB = `org-${crypto.randomUUID()}`;
    const runA = await seedRun(orgA);
    const runB = await seedRun(orgB);
    const eventId = `${runA}:source`;
    await sourceEvent({ runId: runA, id: eventId, seq: 1 });
    const base = {
      provider: "t3",
      providerEventId: eventId,
      deliverySeq: 1,
      structure: {
        kind: "spawn" as const,
        nativeParentSessionId: "parent",
        nativeChildSessionId: "child",
        relevant: true,
        executionRequired: true,
      },
    };
    await expect(stageExecutionGraphObservation({ ...base, orgId: orgA, runId: runB }, testDb))
      .rejects.toThrow();
    await expect(stageExecutionGraphObservation({ ...base, orgId: orgB, runId: runA }, testDb))
      .rejects.toThrow();
    await expect(stageExecutionGraphObservation({ ...base, orgId: orgA, runId: runA, provider: "pi" }, testDb))
      .rejects.toThrow();

    await stageExecutionGraphObservation({ ...base, orgId: orgA, runId: runA }, testDb);
    await expect((async () => {
      await testDb.update(providerEvents).set({ provider: "pi" }).where(
        eq(providerEvents.id, eventId),
      );
    })()).rejects.toThrow();
    await expect((async () => {
      await testDb.update(runs).set({ orgId: orgB }).where(eq(runs.id, runA));
    })()).rejects.toThrow();
    const [source] = await testDb.select().from(providerEvents).where(eq(providerEvents.id, eventId));
    expect(source).toMatchObject({ runId: runA, provider: "t3" });
    await testDb.delete(providerEvents).where(eq(providerEvents.id, eventId));
    expect(await testDb.select().from(executionGraphPendingObservations).where(
      eq(executionGraphPendingObservations.providerEventId, eventId),
    )).toEqual([]);
  });

  test("persists exhaustion and exposes bounded recovery diagnostics", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    const eventId = `${runId}:exhausted`;
    await sourceEvent({ runId, id: eventId, seq: 1 });
    const staged = await stageExecutionGraphObservation({
      orgId,
      runId,
      provider: "t3",
      providerEventId: eventId,
      deliverySeq: 1,
      structure: {
        kind: "spawn",
        nativeParentSessionId: "never-arrives",
        nativeChildSessionId: "child",
        relevant: true,
        executionRequired: true,
      },
    }, testDb);
    for (let attempt = 0; attempt < EXECUTION_GRAPH_RECOVERY_MAX_ATTEMPTS + 3; attempt++) {
      await recordExecutionGraphRecoveryAttempt(staged.row.id, testDb);
    }
    const [row] = await testDb.select().from(executionGraphPendingObservations).where(
      eq(executionGraphPendingObservations.id, staged.row.id),
    );
    expect(row).toMatchObject({
      attemptCount: EXECUTION_GRAPH_RECOVERY_MAX_ATTEMPTS,
      exhaustionCode: "attempt_budget_exhausted",
    });
    expect(row?.exhaustedAt).toBeInstanceOf(Date);
    expect(await executionGraphRecoveryDiagnostics(orgId, runId, testDb)).toMatchObject({
      unresolvedCount: 1,
      exhaustedCount: 1,
      oldestUnresolvedAt: expect.any(Date),
    });
    expect(await executionGraphSealBlockers(orgId, runId, testDb)).toHaveLength(1);
  });
});
