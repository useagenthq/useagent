import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { csvToWorkbook, migrateSlidesToDeck } from "@useagent/artifact-workspace";
import { createArtifactRecord, updateArtifactWorkpiece } from "./repo";
import { createRun } from "../runs/repo";
import {
  artifactSubjectDigest,
  ArtifactQualityIdempotencyConflictError,
  ArtifactQualityStaleSubjectError,
  recordArtifactQuality,
} from "./quality";
import "../../test/helpers";

const ORG = "org-skynet-dev";
const hex = (value: string): string => createHash("sha256").update(value).digest("hex");

async function createWorkpiece(kind: "presentation" | "spreadsheet") {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: `quality ${kind}`,
    model: "test",
    engine: "mock",
    orgId: ORG,
    userId: null,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  const state = kind === "presentation"
    ? { deck: migrateSlidesToDeck([{ title: "Quality", body: "Verified" }]) }
    : { workbook: csvToWorkbook("metric,value\nquality,1") };
  const stored = await createArtifactRecord({
    orgId: ORG,
    userId: null,
    runId,
    threadId: runId,
    sourcePath: `/quality/${runId}.${kind === "presentation" ? "pptx" : "xlsx"}`,
    name: kind === "presentation" ? "quality.pptx" : "quality.xlsx",
    contentType: kind === "presentation"
      ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 10,
    sha256: hex(`${kind}:source`),
    storageKey: `quality/${runId}`,
    workpieceKind: kind,
    workpieceState: state,
  });
  return stored.row;
}

function receiptInput(artifact: Awaited<ReturnType<typeof createWorkpiece>>, key: string) {
  return {
    orgId: artifact.orgId,
    artifactId: artifact.id,
    threadId: artifact.threadId,
    artifactRevision: artifact.workpieceRevision,
    subjectDigest: artifactSubjectDigest(artifact),
    qualityProfile: "office_visual_v1",
    exportFormat: artifact.workpieceKind === "presentation" ? "pptx" : "xlsx",
    exportDigest: hex(`${artifact.id}:export`),
    visualDigest: hex(`${artifact.id}:visual`),
    inspectorVersion: "trusted-inspector-1.0.0",
    idempotencyKey: key,
  } as const;
}

describe("artifact quality receipts", () => {
  test("uses the stored sha256 as the subject for byte-only artifacts", () => {
    const sha256 = hex("byte artifact");
    expect(artifactSubjectDigest({
      sha256,
      workpieceKind: null,
      workpieceState: null,
    })).toBe(sha256);
  });

  test("records exact presentation and spreadsheet subjects", async () => {
    for (const kind of ["presentation", "spreadsheet"] as const) {
      const artifact = await createWorkpiece(kind);
      const result = await recordArtifactQuality(receiptInput(artifact, `quality:${artifact.id}`));
      expect(result.created).toBe(true);
      expect(result.row.artifactId).toBe(artifact.id);
      expect(result.row.subjectDigest).toBe(artifactSubjectDigest(artifact));
      expect(result.row.qualityProfile).toBe("office_visual_v1");
    }
  });

  test("rejects malformed evidence and stale inspected subjects", async () => {
    const artifact = await createWorkpiece("presentation");
    const valid = receiptInput(artifact, `quality:${artifact.id}`);
    await expect(recordArtifactQuality({ ...valid, visualDigest: "A".repeat(64) }))
      .rejects.toThrow("visualDigest is invalid");
    await expect(recordArtifactQuality({ ...valid, exportFormat: "" }))
      .rejects.toThrow("exportFormat is invalid");
    await expect(recordArtifactQuality({ ...valid, subjectDigest: hex("stale") }))
      .rejects.toBeInstanceOf(ArtifactQualityStaleSubjectError);
  });

  test("concurrent identical retries converge and conflicting fingerprints fail", async () => {
    const artifact = await createWorkpiece("spreadsheet");
    const input = receiptInput(artifact, `quality:${artifact.id}`);
    const retries = await Promise.all([
      recordArtifactQuality(input),
      recordArtifactQuality(input),
      recordArtifactQuality(input),
    ]);
    expect(retries.filter((entry) => entry.created)).toHaveLength(1);
    expect(new Set(retries.map((entry) => entry.row.id)).size).toBe(1);
    await expect(recordArtifactQuality({ ...input, exportDigest: hex("different") }))
      .rejects.toBeInstanceOf(ArtifactQualityIdempotencyConflictError);
  });

  test("rejects a receipt after the inspected revision advances", async () => {
    const artifact = await createWorkpiece("spreadsheet");
    const inspected = receiptInput(artifact, `quality:${artifact.id}`);
    const revised = await updateArtifactWorkpiece({
      orgId: artifact.orgId,
      id: artifact.id,
      expectedRevision: artifact.workpieceRevision,
      state: { workbook: csvToWorkbook("metric,value\nquality,2") },
    });
    expect(revised?.workpieceRevision).toBe(artifact.workpieceRevision + 1);
    await expect(recordArtifactQuality(inspected))
      .rejects.toBeInstanceOf(ArtifactQualityStaleSubjectError);
  });
});
