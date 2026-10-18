import { LEGACY_GATEWAY_DATABASE_ROLE } from "../src/db/gateway-grants";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { createArtifactRecord } from "../src/artifacts/repo";
import { db } from "../src/db/client";
import { GATEWAY_GRANTS } from "../src/db/gateway-grants";
import {
  finishedWorkObligations,
  finishedWorkReceipts,
  providerEvents,
} from "../src/db/schema";
import { createRun } from "../src/runs/repo";
import { readStableProviderEvent } from "../src/runs/provider-events";
import "./helpers";
import { DEV_ORG_ID } from "../src/dev-org";
import { PLATFORM_EVENT_LANES } from "@useagent/agent-harness/canonical";

const ORG = DEV_ORG_ID;

describe("restricted gateway FinishedWork grants", () => {
  test("reads scoped lifecycle history with only the gateway column grant", async () => {
    const runId = crypto.randomUUID();
    await createRun({
      id: runId,
      prompt: "restricted history lookup",
      model: "test",
      engine: "mock",
      orgId: ORG,
      userId: null,
      parentRunId: null,
      threadId: runId,
      repos: [],
      memoryScope: "org",
    });
    const role = `receipt_history_${crypto.randomUUID().replaceAll("-", "")}`;
    const eventId = `artifact.created:${crypto.randomUUID()}`;
    const readGrant = GATEWAY_GRANTS.find((grant) =>
      grant.startsWith("GRANT SELECT (") && grant.includes(" ON provider_events "),
    );
    if (!readGrant) throw new Error("gateway lifecycle read grant is missing");
    const rollback = new Error("rollback the isolated role fixture");
    // CREATE ROLE and its grants are transactional: this fixture never commits
    // a cluster-wide role or changes any existing gateway role's privileges.
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE`));
      await tx.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO "${role}"`));
      await tx.execute(sql.raw(readGrant.replaceAll("useagent_gateway", `"${role}"`)));
      await tx.insert(providerEvents).values({
        id: eventId,
        runId,
        threadId: runId,
        seq: 0,
        provider: PLATFORM_EVENT_LANES.platform,
        eventType: "artifact.created",
        payload: "{}",
      });
      await tx.execute(sql.raw(`SET LOCAL ROLE "${role}"`));
      expect(await readStableProviderEvent({ id: eventId, runId, threadId: runId }, tx))
        .toMatchObject({ id: eventId, runId, threadId: runId, provider: PLATFORM_EVENT_LANES.platform, eventType: "artifact.created" });
      expect(await readStableProviderEvent({ id: eventId, runId: crypto.randomUUID(), threadId: runId }, tx))
        .toBeNull();
      throw rollback;
    })).rejects.toBe(rollback);
    const remaining = await db.execute(sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`);
    expect(remaining).toHaveLength(0);
  });

  test("SET ROLE can append receipts and resolve obligations without mutating semantics", async () => {
    const roles = await db.execute(sql`
      select rolname from pg_roles
      where rolname in ('useagent_gateway', ${LEGACY_GATEWAY_DATABASE_ROLE})
      order by (rolname = 'useagent_gateway') desc
      limit 1
    `);
    const role = roles[0]?.rolname;
    if (typeof role !== "string") return;

    const runId = crypto.randomUUID();
    await createRun({
      id: runId,
      prompt: "restricted role proof",
      model: "test",
      engine: "mock",
      orgId: ORG,
      userId: null,
      parentRunId: null,
      threadId: runId,
      repos: [],
      memoryScope: "org",
    });
    const stored = await createArtifactRecord({
      orgId: ORG,
      userId: null,
      runId,
      threadId: runId,
      sourcePath: `/role-proof/${runId}.pdf`,
      name: "role-proof.pdf",
      contentType: "application/pdf",
      sizeBytes: 1,
      sha256: "a".repeat(64),
      storageKey: `role-proof/${runId}`,
    });
    const sourceKey = `gateway:role-proof:${runId}`;

    const ids = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local role "${role}"`));
      const [obligation] = await tx
        .insert(finishedWorkObligations)
        .values({
          orgId: ORG,
          runId,
          threadId: runId,
          sourceKind: "gateway_tool",
          authority: "integration_gateway",
          sourceKey,
          requirement: "artifact_create",
          sourceProvider: "useagent",
          sourceCallId: `rpc:${"b".repeat(64)}`,
          candidateName: "role-proof.pdf",
        })
        .returning();
      if (!obligation) throw new Error("restricted obligation insert failed");
      await tx
        .update(finishedWorkObligations)
        .set({
          materializedArtifactId: stored.row.id,
          materializedArtifactRevision: stored.row.workpieceRevision,
          updatedAt: new Date(),
        })
        .where(eq(finishedWorkObligations.id, obligation.id));
      const [receipt] = await tx
        .insert(finishedWorkReceipts)
        .values({
          orgId: ORG,
          runId,
          threadId: runId,
          obligationId: obligation.id,
          kind: "artifact_created",
          authority: "artifact_store",
          sourceKey,
          artifactId: stored.row.id,
          artifactRevision: stored.row.workpieceRevision,
        })
        .returning();
      if (!receipt) throw new Error("restricted receipt insert failed");
      await tx
        .update(finishedWorkObligations)
        .set({ state: "satisfied", resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(finishedWorkObligations.id, obligation.id));
      return { obligationId: obligation.id, receiptId: receipt.id };
    });

    await expect(db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local role "${role}"`));
      await tx
        .update(finishedWorkReceipts)
        .set({ artifactRevision: 99 })
        .where(eq(finishedWorkReceipts.id, ids.receiptId));
    })).rejects.toThrow();
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local role "${role}"`));
      await tx
        .update(finishedWorkObligations)
        .set({ sourceKey: `${sourceKey}:changed` })
        .where(eq(finishedWorkObligations.id, ids.obligationId));
    })).rejects.toThrow();
  });

  test("artifact_publish create and revision events stay immutable under the restricted role", async () => {
    const roles = await db.execute(sql`
      select rolname from pg_roles
      where rolname in ('useagent_gateway', ${LEGACY_GATEWAY_DATABASE_ROLE})
      order by (rolname = 'useagent_gateway') desc
      limit 1
    `);
    const role = roles[0]?.rolname;
    if (typeof role !== "string") return;

    {
      const runId = crypto.randomUUID();
      await createRun({
        id: runId,
        prompt: "restricted artifact_publish proof",
        model: "test",
        engine: "mock",
        orgId: ORG,
        userId: null,
        parentRunId: null,
        threadId: runId,
        repos: [],
        memoryScope: "org",
      });

      const artifactId = crypto.randomUUID();
      const createdId = `artifact.created:${artifactId}`;
      const revisedId = `artifact.revised:${artifactId}:1`;
      const insert = async (
        tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
        id: string,
        eventType: "artifact.created" | "artifact.revised",
        seq: number,
        sha256: string,
      ) => tx.insert(providerEvents).values({
        id,
        runId,
        threadId: runId,
        seq,
        provider: PLATFORM_EVENT_LANES.platform,
        eventType,
        payload: JSON.stringify({ id: artifactId, sha256 }),
      }).onConflictDoNothing({ target: providerEvents.id }).returning({ id: providerEvents.id });

      const inserted = await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local role "${role}"`));
        return [
          await insert(tx, createdId, "artifact.created", 0, "a".repeat(64)),
          await insert(tx, revisedId, "artifact.revised", 1, "b".repeat(64)),
          await insert(tx, createdId, "artifact.created", 2, "f".repeat(64)),
          await insert(tx, revisedId, "artifact.revised", 3, "f".repeat(64)),
        ];
      });

      expect(inserted.map((rows) => rows.length)).toEqual([1, 1, 0, 0]);
      const events = await db.select({ id: providerEvents.id, payload: providerEvents.payload })
        .from(providerEvents)
        .where(inArray(providerEvents.id, [createdId, revisedId]))
        .orderBy(providerEvents.id);
      expect(events.map(({ id, payload }) => [id, JSON.parse(payload ?? "{}").sha256])).toEqual([
        [createdId, "a".repeat(64)],
        [revisedId, "b".repeat(64)],
      ]);

      await expect(db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local role "${role}"`));
        await tx.update(providerEvents)
          .set({ provider: "forged" })
          .where(eq(providerEvents.id, revisedId));
      })).rejects.toThrow();
    }
  });
});
