import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { createArtifactRecord } from "../src/artifacts/repo";
import { db } from "../src/db/client";
import {
  finishedWorkObligations,
  finishedWorkReceipts,
  providerEvents,
} from "../src/db/schema";
import { createRun } from "../src/runs/repo";
import "./helpers";

const ORG = "org-skynet-dev";

describe("restricted gateway FinishedWork grants", () => {
  test("SET ROLE can append receipts and resolve obligations without mutating semantics", async () => {
    const roles = await db.execute(sql`
      select rolname from pg_roles
      where rolname in ('useagent_gateway', 'skynet_gateway')
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
      where rolname in ('useagent_gateway', 'skynet_gateway')
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
        provider: "skynet",
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
        .where(inArray(providerEvents.id, [createdId, revisedId]));
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
