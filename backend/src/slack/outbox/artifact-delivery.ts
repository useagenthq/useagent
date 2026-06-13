import { getArtifact, toArtifactDescriptor } from "../../artifacts/repo";
import { getRun } from "../../runs/repo";
import { recordProviderEvent } from "../../runs/provider-events";
import { removeStaged } from "../upload-staging";
import type { ClaimedRow } from "./repo";

export async function cleanupStagedIfUpload(row: ClaimedRow): Promise<void> {
  if (row.kind !== "upload_file") return;
  try {
    const payload = JSON.parse(row.payload) as { stagedPath?: string };
    if (payload.stagedPath) await removeStaged(payload.stagedPath);
  } catch {
    // Malformed payloads have no trustworthy staged path to remove.
  }
}

async function recordImmutableArtifactReceipt(row: ClaimedRow): Promise<boolean> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return false;
  }
  const string = (key: string): string | null =>
    typeof payload[key] === "string" && payload[key] ? payload[key] as string : null;
  const snapshot = {
    artifactId: string("artifactId"),
    artifactRunId: string("artifactRunId"),
    artifactThreadId: string("artifactThreadId"),
    deliveryRunId: string("deliveryRunId"),
    orgId: string("orgId"),
    name: string("filename"),
    contentType: string("artifactContentType"),
    sha256: string("artifactSha256"),
    revision: Number.isSafeInteger(payload.artifactRevision)
      ? payload.artifactRevision as number
      : null,
    size: Number.isSafeInteger(payload.size) && (payload.size as number) >= 0
      ? payload.size as number
      : null,
  };
  const hasSnapshot = Object.values(snapshot).every((value) => value !== null);
  const hasSnapshotMarker = [
    "artifactRunId",
    "artifactThreadId",
    "deliveryRunId",
    "artifactContentType",
    "artifactSha256",
    "artifactRevision",
    "artifactStorageKey",
  ].some((key) => key in payload);
  if (!hasSnapshot) return hasSnapshotMarker;

  const deliveryRun = await getRun(snapshot.deliveryRunId!);
  if (
    !deliveryRun ||
    deliveryRun.orgId !== snapshot.orgId ||
    deliveryRun.threadId !== snapshot.artifactThreadId
  ) return true;
  await recordProviderEvent(
    {
      id: [
        "artifact.delivered",
        deliveryRun.id,
        snapshot.artifactId,
        snapshot.revision,
        snapshot.sha256,
      ].join(":"),
      runId: deliveryRun.id,
      threadId: snapshot.artifactThreadId!,
      provider: "skynet",
      eventType: "artifact.delivered",
      payload: {
        id: snapshot.artifactId,
        run_id: snapshot.artifactRunId,
        thread_id: snapshot.artifactThreadId,
        name: snapshot.name,
        content_type: snapshot.contentType,
        size_bytes: snapshot.size,
        sha256: snapshot.sha256,
        delivered_revision: snapshot.revision,
        destination: "slack",
      },
    },
    { critical: true, required: true },
  );
  return true;
}

/** Emit a truthful timeline receipt only after Slack accepted the upload. */
export async function recordArtifactDelivered(row: ClaimedRow): Promise<void> {
  if (row.kind !== "upload_file" || await recordImmutableArtifactReceipt(row)) return;
  let artifactId: string | null = null;
  try {
    const payload = JSON.parse(row.payload) as { artifactId?: unknown };
    artifactId = typeof payload.artifactId === "string" ? payload.artifactId : null;
  } catch {
    return;
  }
  if (!artifactId) return;
  const artifact = await getArtifact(artifactId);
  if (!artifact) return;
  await recordProviderEvent(
    {
      // Preserve the deployed pre-revision identity so migration replay upserts
      // instead of creating a second historical delivery receipt.
      id: `artifact.delivered:${artifact.runId}:${artifact.id}`,
      runId: artifact.runId,
      threadId: artifact.threadId,
      provider: "skynet",
      eventType: "artifact.delivered",
      payload: { ...toArtifactDescriptor(artifact), destination: "slack" },
    },
    { critical: true, required: true },
  );
}
