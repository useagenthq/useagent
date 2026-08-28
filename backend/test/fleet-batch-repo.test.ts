import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "../src/db/client";
import {
  fleetBatchRuns,
  fleetBatches,
  runAdmissions,
  runs,
} from "../src/db/schema";
import {
  ensureFleetBatch,
  FleetBatchIdempotencyConflictError,
  getFleetBatchForOrg,
  preflightFleetBatch,
} from "../src/fleet/batch-repo";

await migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });

const orgId = `org-fleet-batch-${crypto.randomUUID()}`;
const otherOrgId = `org-fleet-batch-${crypto.randomUUID()}`;
const actorId = `user-${crypto.randomUUID()}`;

function runValues(id: string, org = orgId) {
  return {
    id,
    orgId: org,
    userId: actorId,
    prompt: "fan-out item",
    model: "test",
    engine: "mock" as const,
    status: "queued" as const,
    threadId: id,
  };
}

afterAll(async () => {
  await db.delete(runs).where(sql`${runs.orgId} in (${orgId}, ${otherOrgId})`);
  await db.delete(fleetBatches).where(sql`${fleetBatches.orgId} in (${orgId}, ${otherOrgId})`);
});

describe("fleet batch repository", () => {
  test("inserts atomically in a caller transaction and reads ordered derived states", async () => {
    const runIds = Array.from({ length: 3 }, () => `batch-run-${crypto.randomUUID()}`);
    const result = await db.transaction(async (tx) => {
      await tx.insert(runs).values(runIds.map((id) => runValues(id)));
      await tx.insert(runAdmissions).values(runIds.map((runId, index) => ({
        runId,
        orgId,
        threadId: runId,
        engine: "mock",
        model: "test",
        cpuMillicores: 1,
        memoryMib: 1,
        priority: 0,
        state: index === 0 ? "running" as const : "queued" as const,
        queueReason: index === 1 ? "org_limit" as const : null,
      })));
      await tx.update(runs).set({ status: "running" }).where(eq(runs.id, runIds[0]!));
      return ensureFleetBatch({
        orgId,
        actorId,
        idempotencyKey: "raw-secret-batch-key",
        requestFingerprint: "a".repeat(64),
        runIds,
      }, tx);
    });

    expect(result.created).toBe(true);
    expect(result.batch.runs).toEqual([
      expect.objectContaining({
        ordinal: 0,
        runId: runIds[0],
        runStatus: "running",
        admissionState: "running",
        queueReason: null,
      }),
      expect.objectContaining({
        ordinal: 1,
        runId: runIds[1],
        runStatus: "queued",
        admissionState: "queued",
        queueReason: "org_limit",
      }),
      expect.objectContaining({ ordinal: 2, runId: runIds[2] }),
    ]);
    const [stored] = await db
      .select({ hash: fleetBatches.idempotencyKeyHash })
      .from(fleetBatches)
      .where(and(eq(fleetBatches.orgId, orgId), eq(fleetBatches.id, result.batch.id)));
    expect(stored?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.hash).not.toContain("raw-secret-batch-key");
    expect(await getFleetBatchForOrg(otherOrgId, result.batch.id)).toBeNull();
    await expect(preflightFleetBatch({
      orgId,
      actorId,
      idempotencyKey: "raw-secret-batch-key",
      requestFingerprint: "a".repeat(64),
      itemCount: runIds.length,
    })).resolves.toMatchObject({ id: result.batch.id });
    await expect(preflightFleetBatch({
      orgId,
      actorId,
      idempotencyKey: "raw-secret-batch-key",
      requestFingerprint: "a".repeat(64),
      itemCount: runIds.length - 1,
    })).rejects.toBeInstanceOf(FleetBatchIdempotencyConflictError);

    const replay = await ensureFleetBatch({
      batchId: crypto.randomUUID(),
      orgId,
      actorId,
      idempotencyKey: "raw-secret-batch-key",
      requestFingerprint: "a".repeat(64),
      runIds,
    });
    expect(replay).toMatchObject({ created: false, batch: { id: result.batch.id } });

    await expect(ensureFleetBatch({
      orgId,
      actorId,
      idempotencyKey: "raw-secret-batch-key",
      requestFingerprint: "b".repeat(64),
      runIds,
    })).rejects.toBeInstanceOf(FleetBatchIdempotencyConflictError);
  });

  test("rejects cross-tenant membership and rolls back the batch row", async () => {
    const foreignRunId = `batch-run-${crypto.randomUUID()}`;
    await db.insert(runs).values(runValues(foreignRunId, otherOrgId));
    const key = `cross-tenant-${crypto.randomUUID()}`;
    await expect(ensureFleetBatch({
      orgId,
      actorId,
      idempotencyKey: key,
      requestFingerprint: "c".repeat(64),
      runIds: [foreignRunId],
    })).rejects.toThrow("fleet_batch_run_tenant_mismatch");
    expect(await db
      .select()
      .from(fleetBatches)
      .where(eq(fleetBatches.orgId, orgId)))
      .not.toContainEqual(expect.objectContaining({ requestFingerprint: "c".repeat(64) }));
  });

  test("run deletion retains an honest replayable membership tombstone", async () => {
    const runId = `batch-run-${crypto.randomUUID()}`;
    const idempotencyKey = `cascade-${crypto.randomUUID()}`;
    await db.insert(runs).values(runValues(runId));
    const { batch } = await ensureFleetBatch({
      orgId,
      actorId,
      idempotencyKey,
      requestFingerprint: "d".repeat(64),
      runIds: [runId],
    });
    await db.delete(runs).where(eq(runs.id, runId));
    const memberships = await db
      .select()
      .from(fleetBatchRuns)
      .where(and(eq(fleetBatchRuns.orgId, orgId), eq(fleetBatchRuns.batchId, batch.id)));
    expect(memberships).toHaveLength(1);
    await expect(getFleetBatchForOrg(orgId, batch.id)).resolves.toMatchObject({
      runs: [{ runId, runStatus: "deleted" }],
    });
    await expect(preflightFleetBatch({
      orgId,
      actorId,
      idempotencyKey,
      requestFingerprint: "d".repeat(64),
      itemCount: 1,
    })).resolves.toMatchObject({ id: batch.id, runs: [{ runStatus: "deleted" }] });
    await expect(ensureFleetBatch({
      orgId,
      actorId,
      idempotencyKey,
      requestFingerprint: "d".repeat(64),
      runIds: [runId],
    })).resolves.toMatchObject({
      created: false,
      batch: { id: batch.id, runs: [{ runStatus: "deleted" }] },
    });
  });

  test("enforces the product fan-out bound before writing", async () => {
    await expect(ensureFleetBatch({
      orgId,
      actorId,
      idempotencyKey: `too-wide-${crypto.randomUUID()}`,
      requestFingerprint: "e".repeat(64),
      runIds: Array.from({ length: 21 }, (_, index) => `run-${index}`),
    })).rejects.toThrow("fleet_batch_item_count_invalid");
  });
});
