import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createArtifactRecord } from "../src/artifacts/repo";
import {
  artifactStorageKeyIsReferenced,
  listReferencedArtifactStorageKeys,
} from "../src/artifacts/reclaim";
import { db } from "../src/db/client";
import { artifacts, githubChangeSets, runs, userUploads } from "../src/db/schema";
import { createUserUpload } from "../src/uploads/repo";
import "./helpers";
import { DEV_ORG_ID } from "../src/dev-org";

const runIds = new Set<string>();
const uploadIds = new Set<string>();

afterEach(async () => {
  for (const uploadId of uploadIds) {
    await db.delete(userUploads).where(eq(userUploads.id, uploadId));
  }
  for (const runId of runIds) {
    await db.delete(artifacts).where(eq(artifacts.runId, runId));
    await db.delete(runs).where(eq(runs.id, runId));
  }
  uploadIds.clear();
  runIds.clear();
});

describe("artifact storage references", () => {
  test("treats artifact, preview, upload, and GitHub payload rows as live references", async () => {
    const runId = crypto.randomUUID();
    const artifactKey = "1".repeat(64);
    const uploadKey = "2".repeat(64);
    const previewKey = "3".repeat(64);
    const githubKey = "4".repeat(64);
    runIds.add(runId);

    await db.insert(runs).values({
      id: runId,
      orgId: DEV_ORG_ID,
      userId: "user-reclaim",
      prompt: "publish artifact",
      model: "mock",
      engine: "mock",
      status: "completed",
      threadId: runId,
    });
    const artifact = await createArtifactRecord({
      orgId: DEV_ORG_ID,
      userId: "user-reclaim",
      runId,
      threadId: runId,
      sourcePath: "/root/work/result.txt",
      name: "result.txt",
      contentType: "text/plain",
      sizeBytes: 6,
      sha256: artifactKey,
      storageKey: artifactKey,
    });
    await db.update(artifacts)
      .set({ previewStorageKey: previewKey })
      .where(eq(artifacts.id, artifact.row.id));
    const upload = await createUserUpload({
      orgId: DEV_ORG_ID,
      userId: "user-reclaim",
      name: "input.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      sha256: uploadKey,
      storageKey: uploadKey,
      expiresAt: new Date(Date.now() + 60_000),
    });
    uploadIds.add(upload.id);
    await db.insert(githubChangeSets).values({
      orgId: DEV_ORG_ID,
      userId: "user-reclaim",
      runId,
      threadId: runId,
      repoFullName: "loopai/reclaim-test",
      baseRef: "main",
      baseSha: "a".repeat(40),
      manifest: { version: 1, files: [{ path: "result.txt", action: "add", sha256: artifactKey, sizeBytes: 6, mode: "100644" }] },
      manifestSizeBytes: 120,
      payloadStorageKey: githubKey,
      payloadSha256: githubKey,
      payloadSizeBytes: 6,
      fingerprint: "f".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const keys = await listReferencedArtifactStorageKeys();
    expect(keys.has(artifactKey)).toBe(true);
    expect(keys.has(uploadKey)).toBe(true);
    expect(keys.has(previewKey)).toBe(true);
    expect(keys.has(githubKey)).toBe(true);
    expect(keys.has("5".repeat(64))).toBe(false);
    expect(await artifactStorageKeyIsReferenced(previewKey)).toBe(true);
    expect(await artifactStorageKeyIsReferenced(githubKey)).toBe(true);
    expect(await artifactStorageKeyIsReferenced("5".repeat(64))).toBe(false);
  });
});
