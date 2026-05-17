import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createArtifactRecord } from "../src/artifacts/repo";
import { listReferencedArtifactStorageKeys } from "../src/artifacts/reclaim";
import { db } from "../src/db/client";
import { artifacts, runs, userUploads } from "../src/db/schema";
import { createUserUpload } from "../src/uploads/repo";
import "./helpers";

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
  test("treats artifact rows and user-upload rows as live storage references", async () => {
    const runId = crypto.randomUUID();
    const artifactKey = "1".repeat(64);
    const uploadKey = "2".repeat(64);
    runIds.add(runId);

    await db.insert(runs).values({
      id: runId,
      orgId: "org-skynet-dev",
      userId: "user-reclaim",
      prompt: "publish artifact",
      model: "mock",
      engine: "mock",
      status: "completed",
      threadId: runId,
    });
    await createArtifactRecord({
      orgId: "org-skynet-dev",
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
    const upload = await createUserUpload({
      orgId: "org-skynet-dev",
      userId: "user-reclaim",
      name: "input.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      sha256: uploadKey,
      storageKey: uploadKey,
      expiresAt: new Date(Date.now() + 60_000),
    });
    uploadIds.add(upload.id);

    const keys = await listReferencedArtifactStorageKeys();
    expect(keys.has(artifactKey)).toBe(true);
    expect(keys.has(uploadKey)).toBe(true);
    expect(keys.has("3".repeat(64))).toBe(false);
  });
});
