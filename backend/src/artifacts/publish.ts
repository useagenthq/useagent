import { createHash } from "node:crypto";
import { basename } from "node:path";
import { contentTypeForName } from "./mime";
import {
  createArtifactRecord,
  getArtifactForOrg,
  toArtifactDescriptor,
  type ArtifactDescriptor,
  type ArtifactRecord,
} from "./repo";
import { db } from "../db/client";
import { sql } from "drizzle-orm";
import { artifactStorage } from "./storage";
import { getRunForOrg } from "../runs/repo";
import { recordProviderEvent } from "../runs/provider-events";
import { downloadSandboxFile } from "../slack/sandbox-file";

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

function safeName(sourcePath: string, requested?: string): string {
  const candidate = requested?.trim() || basename(sourcePath.replaceAll("\\", "/")) || "artifact";
  return candidate.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 180) || "artifact";
}

function checkedSourcePath(value: string): string {
  const path = value.trim();
  if (!path || path.length > 4_096 || path.includes("\0")) {
    throw new Error("artifact path must be a non-empty sandbox path under 4096 characters");
  }
  return path;
}

export async function publishSandboxArtifact(input: {
  readonly orgId: string;
  readonly userId: string | null;
  readonly runId: string;
  readonly threadId?: string;
  readonly path: string;
  readonly name?: string;
}): Promise<{ artifact: ArtifactDescriptor; record: ArtifactRecord; created: boolean }> {
  const sourcePath = checkedSourcePath(input.path);
  const run = await getRunForOrg(input.orgId, input.runId);
  if (!run || (input.threadId && run.threadId !== input.threadId)) {
    throw new Error("run not found in this thread");
  }
  if (!run.sandboxId) throw new Error("no sandbox is attached to this run");

  const file = await downloadSandboxFile(run.sandboxId, sourcePath, MAX_ARTIFACT_BYTES);
  const digest = createHash("sha256").update(file.bytes).digest("hex");
  const name = safeName(sourcePath, input.name);
  const stored = await db.transaction(async (tx) => {
    // Serialize one logical publication across processes. Without this lock, a
    // creator that fails storage verification can roll back metadata already
    // returned by a concurrent idempotent publisher.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${[
      "artifact-publish",
      input.orgId,
      run.id,
      sourcePath,
      digest,
    ].join(":")}))`);
    const record = await createArtifactRecord({
      orgId: input.orgId,
      userId: input.userId,
      runId: run.id,
      threadId: run.threadId,
      sourcePath,
      name,
      contentType: contentTypeForName(name),
      sizeBytes: file.bytes.length,
      sha256: digest,
      storageKey: digest,
    }, tx);
    // Metadata is transactional but must precede bytes so orphan reclamation's
    // final database check sees the in-flight publication. A storage failure
    // rolls the row back while retaining at most a reclaimable content blob.
    await artifactStorage().put(digest, file.bytes);
    const storedSize = await artifactStorage().size(digest);
    if (storedSize !== file.bytes.length) {
      throw new Error("artifact storage size verification failed");
    }
    return record;
  });

  const descriptor = toArtifactDescriptor(stored.row);
  await recordProviderEvent(
    {
      id: `artifact.created:${stored.row.id}`,
      runId: run.id,
      threadId: run.threadId,
      provider: "skynet",
      eventType: "artifact.created",
      payload: descriptor,
    },
    { critical: true },
  );
  return { artifact: descriptor, record: stored.row, created: stored.created };
}

export async function resolveArtifactForThread(input: {
  readonly orgId: string;
  readonly threadId: string;
  readonly artifactId: string;
}): Promise<ArtifactRecord | null> {
  const artifact = await getArtifactForOrg(input.orgId, input.artifactId);
  return artifact?.threadId === input.threadId ? artifact : null;
}
