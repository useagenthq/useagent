import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createArtifactRecord } from "../src/artifacts/repo";
import { db } from "../src/db/client";
import { finishedWorkObligations, finishedWorkReceipts } from "../src/db/schema";
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
});
