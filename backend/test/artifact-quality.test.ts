import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { migrateSlidesToDeck } from "@useagent/artifact-workspace";
import { createArtifactRecord, updateArtifactWorkpiece } from "../src/artifacts/repo";
import { artifactSubjectDigest, recordArtifactQuality } from "../src/artifacts/quality";
import { createRun } from "../src/runs/repo";
import { createOrgSession, json, type OrgSession } from "./helpers";

const hex = (value: string): string => createHash("sha256").update(value).digest("hex");
let owner: OrgSession;
let outsider: OrgSession;

async function createPresentation(session: OrgSession) {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "quality route",
    model: "test",
    engine: "mock",
    orgId: session.orgId,
    userId: session.email,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  return (await createArtifactRecord({
    orgId: session.orgId,
    userId: session.email,
    runId,
    threadId: runId,
    sourcePath: `/quality/${runId}.pptx`,
    name: "quality.pptx",
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    sizeBytes: 10,
    sha256: hex(`source:${runId}`),
    storageKey: `quality/${runId}`,
    workpieceKind: "presentation",
    workpieceState: { deck: migrateSlidesToDeck([{ title: "Quality", body: "Route" }]) },
  })).row;
}

beforeAll(async () => {
  owner = await createOrgSession("artifact-quality-owner");
  outsider = await createOrgSession("artifact-quality-outsider");
});

describe("GET /api/artifacts/:id/quality", () => {
  test("is unverified without trusted renderer and inspector evidence", async () => {
    const artifact = await createPresentation(owner);
    const response = await json(`/api/artifacts/${artifact.id}/quality`, { cookies: owner.cookies });
    expect(response).toEqual({
      status: 200,
      body: {
        status: "unverified",
        artifactRevision: 0,
        subjectDigest: artifactSubjectDigest(artifact),
      },
    });
  });

  test("returns only an exact-current receipt and ignores revision history", async () => {
    const artifact = await createPresentation(owner);
    const subjectDigest = artifactSubjectDigest(artifact);
    const recorded = await recordArtifactQuality({
      orgId: owner.orgId,
      artifactId: artifact.id,
      threadId: artifact.threadId,
      artifactRevision: artifact.workpieceRevision,
      subjectDigest,
      qualityProfile: "office_visual_v1",
      exportFormat: "pptx",
      exportDigest: hex("export"),
      visualDigest: hex("visual"),
      inspectorVersion: "trusted-inspector-1.0.0",
      idempotencyKey: `quality:${artifact.id}`,
    });
    const verified = await json<Record<string, unknown>>(
      `/api/artifacts/${artifact.id}/quality`,
      { cookies: owner.cookies },
    );
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({
      status: "verified",
      receipt: {
        id: recorded.row.id,
        artifactId: artifact.id,
        artifactRevision: 0,
        subjectDigest,
        qualityProfile: "office_visual_v1",
        exportFormat: "pptx",
      },
    });
    expect(verified.body.receipt).not.toHaveProperty("idempotencyKeyHash");
    expect(verified.body.receipt).not.toHaveProperty("requestFingerprint");

    await updateArtifactWorkpiece({
      orgId: owner.orgId,
      id: artifact.id,
      expectedRevision: 0,
      state: { deck: migrateSlidesToDeck([{ title: "Revised", body: "No receipt" }]) },
    });
    const revised = await json<Record<string, unknown>>(
      `/api/artifacts/${artifact.id}/quality`,
      { cookies: owner.cookies },
    );
    expect(revised.status).toBe(200);
    expect(revised.body.status).toBe("unverified");
    expect(revised.body.artifactRevision).toBe(1);
    expect(revised.body.subjectDigest).not.toBe(subjectDigest);

    const replay = await recordArtifactQuality({
      orgId: owner.orgId,
      artifactId: artifact.id,
      threadId: artifact.threadId,
      artifactRevision: artifact.workpieceRevision,
      subjectDigest,
      qualityProfile: "office_visual_v1",
      exportFormat: "pptx",
      exportDigest: hex("export"),
      visualDigest: hex("visual"),
      inspectorVersion: "trusted-inspector-1.0.0",
      idempotencyKey: `quality:${artifact.id}`,
    });
    expect(replay).toEqual({ row: recorded.row, created: false });
  });

  test("fails closed across organizations", async () => {
    const artifact = await createPresentation(owner);
    const response = await json(`/api/artifacts/${artifact.id}/quality`, {
      cookies: outsider.cookies,
    });
    expect(response).toEqual({ status: 404, body: { error: "not found" } });
  });
});
