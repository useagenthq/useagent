import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { commands, fleetBatches, runAdmissions, runs, sandboxLeases } from "../src/db/schema";
import { admitClaimedRun } from "../src/fleet/admission";
import { reservationSnapshot } from "../src/fleet/lease-repo";
import { isBearerAllowedPath } from "../src/middleware/bearer";
import { createOrgSession, json, uid } from "./helpers";

const previousRollout = process.env.FLEET_BATCH_ROLLOUT;
const previousGlobalCap = process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES;
const previousOrgCap = process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES;
const previousQueueDepth = process.env.FLEET_ORG_MAX_QUEUE_DEPTH;
const previousHostCpu = process.env.FLEET_HOST_CPU_MILLICORES;
const previousHostMemory = process.env.FLEET_HOST_MEMORY_MIB;

beforeAll(() => {
  process.env.FLEET_BATCH_ROLLOUT = "write";
});

afterAll(() => {
  if (previousRollout === undefined) delete process.env.FLEET_BATCH_ROLLOUT;
  else process.env.FLEET_BATCH_ROLLOUT = previousRollout;
  if (previousGlobalCap === undefined) delete process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES;
  else process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES = previousGlobalCap;
  if (previousOrgCap === undefined) delete process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES;
  else process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES = previousOrgCap;
  if (previousQueueDepth === undefined) delete process.env.FLEET_ORG_MAX_QUEUE_DEPTH;
  else process.env.FLEET_ORG_MAX_QUEUE_DEPTH = previousQueueDepth;
  if (previousHostCpu === undefined) delete process.env.FLEET_HOST_CPU_MILLICORES;
  else process.env.FLEET_HOST_CPU_MILLICORES = previousHostCpu;
  if (previousHostMemory === undefined) delete process.env.FLEET_HOST_MEMORY_MIB;
  else process.env.FLEET_HOST_MEMORY_MIB = previousHostMemory;
});

async function post(
  cookies: string,
  key: string | null,
  body: unknown,
) {
  return json<any>("/api/fleet/batches", {
    method: "POST",
    cookies,
    headers: key ? { "Idempotency-Key": key } : {},
    body,
  });
}

describe("fleet batch API", () => {
  test("accepts all roots atomically, returns the client contract, and replays exact ids", async () => {
    const org = await createOrgSession("fleet-batch-api");
    const key = uid("fleet-batch-key");
    const body = {
      tasks: [
        { prompt: "first independent task", engine: "mock" },
        { prompt: "second independent task", engine: "mock", repos: [] },
      ],
    };

    const first = await post(org.cookies, key, body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      replayed: false,
      counts: { total: 2 },
      runs: [
        { ordinal: 0, status: expect.any(String), queue: expect.anything() },
        { ordinal: 1, status: expect.any(String), queue: expect.anything() },
      ],
    });
    expect(first.body.batch_id).toMatch(/^[0-9a-f-]{36}$/);
    const runIds = first.body.runs.map((run: any) => run.run_id);
    expect(new Set(runIds).size).toBe(2);

    const stored = await db
      .select({ id: runs.id, parentRunId: runs.parentRunId, threadId: runs.threadId })
      .from(runs)
      .where(and(eq(runs.orgId, org.orgId), inArray(runs.id, runIds)));
    expect(stored).toHaveLength(2);
    expect(stored.every((run) => run.parentRunId === null && run.threadId === run.id)).toBe(true);

    const replay = await post(org.cookies, key, body);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.batch_id).toBe(first.body.batch_id);
    expect(replay.body.runs.map((run: any) => run.run_id)).toEqual(runIds);

    const read = await json<any>(`/api/fleet/batches/${first.body.batch_id}`, {
      cookies: org.cookies,
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ batch_id: first.body.batch_id, replayed: false });

    const otherOrg = await createOrgSession("fleet-batch-api-other");
    expect((await json(`/api/fleet/batches/${first.body.batch_id}`, {
      cookies: otherOrg.cookies,
    })).status).toBe(404);
  });

  test("same key with a changed fingerprint is a whole-batch 409", async () => {
    const org = await createOrgSession("fleet-batch-conflict");
    const key = uid("fleet-batch-conflict");
    const first = await post(org.cookies, key, {
      tasks: [{ prompt: "original", engine: "mock" }],
    });
    expect(first.status).toBe(201);

    const conflict = await post(org.cookies, key, {
      tasks: [{ prompt: "changed", engine: "mock" }],
    });
    expect(conflict).toEqual({ status: 409, body: { error: "idempotency_key_reused" } });
    expect((await db.select({ id: fleetBatches.id }).from(fleetBatches)
      .where(eq(fleetBatches.orgId, org.orgId))).length).toBe(1);
  });

  test("concurrent exact retries create one batch and return one ordered run set", async () => {
    const org = await createOrgSession("fleet-batch-concurrent-replay");
    const key = uid("fleet-batch-concurrent-replay");
    const body = {
      tasks: [
        { prompt: "concurrent one", engine: "mock" },
        { prompt: "concurrent two", engine: "mock" },
      ],
    };

    const responses = await Promise.all([
      post(org.cookies, key, body),
      post(org.cookies, key, body),
    ]);
    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 201]);
    expect(new Set(responses.map((response) => response.body.batch_id)).size).toBe(1);
    expect(responses[0]!.body.runs.map((run: any) => run.run_id)).toEqual(
      responses[1]!.body.runs.map((run: any) => run.run_id),
    );
    expect((await db.select({ id: fleetBatches.id }).from(fleetBatches)
      .where(eq(fleetBatches.orgId, org.orgId))).length).toBe(1);
  });

  test("invalid trust fields and a queue overflow leave zero batch/run/command rows", async () => {
    const invalidOrg = await createOrgSession("fleet-batch-invalid");
    const invalid = await post(invalidOrg.cookies, uid("invalid"), {
      tasks: [{ prompt: "forged", engine: "mock", parent_run_id: "trusted-parent" }],
    });
    expect(invalid).toEqual({
      status: 400,
      body: { error: "invalid_batch_task", index: 0 },
    });
    expect((await db.select({ id: runs.id }).from(runs)
      .where(eq(runs.orgId, invalidOrg.orgId))).length).toBe(0);

    const queueOrg = await createOrgSession("fleet-batch-overflow");
    process.env.FLEET_ORG_MAX_QUEUE_DEPTH = "1";
    try {
      const overflow = await post(queueOrg.cookies, uid("overflow"), {
        tasks: [
          { prompt: "one", engine: "mock" },
          { prompt: "two", engine: "mock" },
        ],
      });
      expect(overflow.status).toBe(429);
      expect(overflow.body).toMatchObject({ error: "fleet_queue_full", limit: 1 });
    } finally {
      process.env.FLEET_ORG_MAX_QUEUE_DEPTH = previousQueueDepth ?? "1000000";
    }
    const [runRows, commandRows, admissionRows, batchRows] = await Promise.all([
      db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, queueOrg.orgId)),
      db.select({ id: commands.id }).from(commands).where(eq(commands.orgId, queueOrg.orgId)),
      db.select({ id: runAdmissions.runId }).from(runAdmissions)
        .where(eq(runAdmissions.orgId, queueOrg.orgId)),
      db.select({ id: fleetBatches.id }).from(fleetBatches)
        .where(eq(fleetBatches.orgId, queueOrg.orgId)),
    ]);
    expect([runRows, commandRows, admissionRows, batchRows].map((rows) => rows.length))
      .toEqual([0, 0, 0, 0]);
  });

  test("persists all 20 independent tasks and admits exactly eight under an eight-sandbox cap", async () => {
    // This proof owns host-global capacity. Earlier suites intentionally retain
    // reusable sandbox mappings, which count against that same global budget.
    await db.transaction(async (tx) => {
      await tx.execute(sql`delete from run_admissions`);
      await tx.execute(sql`delete from sandbox_leases`);
      await tx.execute(sql`update runs set sandbox_id = null where sandbox_id is not null`);
    });
    const org = await createOrgSession("fleet-batch-twenty");
    process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES = "0";
    process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES = "8";
    process.env.FLEET_ORG_MAX_QUEUE_DEPTH = "40";
    process.env.FLEET_HOST_CPU_MILLICORES = "100000";
    process.env.FLEET_HOST_MEMORY_MIB = "1000000";
    try {
      const created = await post(org.cookies, uid("twenty"), {
        tasks: Array.from({ length: 20 }, (_, index) => ({
          prompt: `independent task ${index}`,
          engine: "mock",
        })),
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        replayed: false,
        status: "queued",
        counts: { total: 20, queued: 20 },
      });
      expect(created.body.runs).toHaveLength(20);
      expect(created.body.runs.every((run: any) => run.queue?.state === "queued")).toBe(true);

      // The API accepted every root while global admission was closed. Re-open
      // capacity at eight and drive the existing provider-neutral gate directly,
      // so the assertion is deterministic and does not depend on actor timing.
      process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES = "8";
      const runIds = created.body.runs.map((run: any) => run.run_id as string);
      const decisions = await Promise.all(runIds.map((runId: string) => admitClaimedRun(runId)));
      expect(decisions.filter((decision) => decision.admit)).toHaveLength(8);
      expect((await reservationSnapshot(org.orgId)).globalActiveSandboxes).toBe(8);

      const durable = await db.execute(sql`
        select state, count(*)::int as count
        from run_admissions
        where org_id = ${org.orgId}
        group by state
        order by state
      `) as unknown as Array<{ state: string; count: number }>;
      expect(Object.fromEntries(durable.map((row) => [row.state, row.count]))).toEqual({
        leased: 8,
        queued: 12,
      });
    } finally {
      // This proof mints eight real leases and leaves twelve durable commands
      // queued by design. Settle this org before restoring wide suite limits so
      // the background reconciler cannot start test work in a later file.
      await db.execute(sql`
        update runs set status = 'failed', settled_at = now(), updated_at = now()
        where org_id = ${org.orgId} and status in ('queued', 'running')
      `);
      await db.execute(sql`
        update commands set state = 'completed', updated_at = now()
        where org_id = ${org.orgId} and kind = 'run.create'
          and state in ('queued', 'dispatched')
      `);
      await db.execute(sql`delete from sandbox_leases where org_id = ${org.orgId}`);
      await db.execute(sql`delete from run_admissions where org_id = ${org.orgId}`);
      process.env.FLEET_GLOBAL_MAX_ACTIVE_SANDBOXES = previousGlobalCap ?? "100000";
      process.env.FLEET_ORG_MAX_ACTIVE_SANDBOXES = previousOrgCap ?? "100000";
      process.env.FLEET_ORG_MAX_QUEUE_DEPTH = previousQueueDepth ?? "1000000";
      process.env.FLEET_HOST_CPU_MILLICORES = previousHostCpu ?? "100000";
      process.env.FLEET_HOST_MEMORY_MIB = previousHostMemory ?? "1000000";
    }
  });

  test("rollout is fail-closed and bearer access is exact", async () => {
    const org = await createOrgSession("fleet-batch-rollout-api");
    process.env.FLEET_BATCH_ROLLOUT = "off";
    expect((await post(org.cookies, uid("off"), {
      tasks: [{ prompt: "off", engine: "mock" }],
    })).status).toBe(404);
    process.env.FLEET_BATCH_ROLLOUT = "read";
    expect((await post(org.cookies, uid("read"), {
      tasks: [{ prompt: "read", engine: "mock" }],
    })).status).toBe(403);
    process.env.FLEET_BATCH_ROLLOUT = "write";

    expect(isBearerAllowedPath("POST", "/api/fleet/batches")).toBe(true);
    expect(isBearerAllowedPath("POST", "/api/fleet/batches/extra")).toBe(false);
    expect(isBearerAllowedPath("GET", "/api/fleet/batches/batch-id")).toBe(true);
    expect(isBearerAllowedPath("GET", "/api/fleet/batches/batch-id/extra")).toBe(false);
  });
});
