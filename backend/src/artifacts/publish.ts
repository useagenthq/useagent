import { createHash } from "node:crypto";
import { basename } from "node:path";
import { contentTypeForName } from "./mime";
import {
  createArtifactRecord,
  getArtifactForOrg,
  reviseArtifactPublication,
  toArtifactDescriptor,
  updateArtifactPreview,
  type ArtifactDescriptor,
  type ArtifactRecord,
} from "./repo";
import {
  convertOfficeToPdf,
  isOfficePreviewContentType,
  OFFICE_PREVIEW_MAX_BYTES,
  OFFICE_PREVIEW_TIMEOUT_SECONDS,
} from "./office-preview";
import { db } from "../db/client";
import { sql } from "drizzle-orm";
import { artifactStorage } from "./storage";
import { getRunForOrg } from "../runs/repo";
import { publishOrgChange } from "../runs/org-signals";
import { recordProviderEvent } from "../runs/provider-events";
import { downloadSandboxFile } from "../slack/sandbox-file";
import {
  buildInitialWorkpieceState,
  inferWorkpieceKind,
  MAX_WORKPIECE_STATE_BYTES,
} from "./workpiece";

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

/** Best-effort Office->PDF preview attachment. For an Office binary, convert the
 * just-published file in the sandbox and store the PDF as a linked preview on the
 * SAME artifact; any failure is silent (download-only, as before) with one log
 * line. On a revision (`regenerate`), a fresh preview replaces the old one, and a
 * failed conversion clears the now-stale preview rather than leaving wrong bytes. */
async function attachOfficePreview(
  input: {
    readonly orgId: string;
    readonly record: ArtifactRecord;
    readonly sandboxId: string;
    readonly sourcePath: string;
  },
  opts: { readonly regenerate: boolean },
): Promise<ArtifactRecord> {
  const clearStale = async (): Promise<ArtifactRecord> => {
    if (!opts.regenerate || !input.record.previewStorageKey) return input.record;
    return (await updateArtifactPreview({
      orgId: input.orgId,
      id: input.record.id,
      previewStorageKey: null,
    })) ?? input.record;
  };
  if (!isOfficePreviewContentType(input.record.contentType)) return clearStale();
  if (!opts.regenerate && input.record.previewStorageKey) return input.record;

  const pdf = await convertOfficeToPdf({
    sandboxId: input.sandboxId,
    sourcePath: input.sourcePath,
    timeoutSeconds: OFFICE_PREVIEW_TIMEOUT_SECONDS,
    maxBytes: OFFICE_PREVIEW_MAX_BYTES,
  });
  if (!pdf) {
    console.log(
      `[office-preview] no PDF preview for artifact ${input.record.id} (${input.record.name})`,
    );
    return clearStale();
  }
  const previewKey = createHash("sha256").update(pdf).digest("hex");
  await artifactStorage().put(previewKey, pdf);
  return (await updateArtifactPreview({
    orgId: input.orgId,
    id: input.record.id,
    previewStorageKey: previewKey,
  })) ?? input.record;
}

export async function publishSandboxArtifact(input: {
  readonly orgId: string;
  readonly userId: string | null;
  readonly runId: string;
  readonly threadId?: string;
  readonly path: string;
  readonly name?: string;
  readonly editablePath?: string;
  /** When set, the new bytes + companion land as a NEW REVISION of this existing
   * artifact (same org + same workpiece kind), not a new artifact. */
  readonly updatesArtifactId?: string;
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
  const contentType = contentTypeForName(name);
  const workpieceKind = inferWorkpieceKind(name, contentType, file.bytes.length);
  const editablePath = input.editablePath ? checkedSourcePath(input.editablePath) : null;
  if (editablePath && !workpieceKind) {
    throw new Error("editable_path can only accompany a supported document or spreadsheet");
  }
  const editable = editablePath
    ? await downloadSandboxFile(run.sandboxId, editablePath, MAX_WORKPIECE_STATE_BYTES)
    : null;
  const workpieceState = workpieceKind
    ? buildInitialWorkpieceState({
        kind: workpieceKind,
        sourceName: name,
        sourceContentType: contentType,
        sourceBytes: file.bytes,
        ...(editablePath && editable
          ? { editable: { name: basename(editablePath), bytes: editable.bytes } }
          : {}),
      })
    : null;
  if (editable && !workpieceState) {
    throw new Error("editable_path must be valid UTF-8 HTML for documents or CSV for spreadsheets");
  }

  // Republish-as-revision: instead of creating a new artifact, replace an existing
  // artifact's bytes + companion in place as a new revision, so a regenerated
  // deliverable stays one tab with history. Same org (getArtifactForOrg) and same
  // workpiece kind family are required; provenance is the publishing run.
  if (input.updatesArtifactId) {
    const target = await getArtifactForOrg(input.orgId, input.updatesArtifactId);
    if (!target) throw new Error("artifact to update was not found in this workspace");
    if (!target.workpieceKind || !workpieceKind || target.workpieceKind !== workpieceKind) {
      throw new Error(
        `republished file kind does not match the artifact being updated (expected ${
          target.workpieceKind ?? "non-workpiece"
        })`,
      );
    }
    await artifactStorage().put(digest, file.bytes);
    if ((await artifactStorage().size(digest)) !== file.bytes.length) {
      throw new Error("artifact storage size verification failed");
    }
    const revised = await reviseArtifactPublication({
      orgId: input.orgId,
      id: target.id,
      name,
      contentType,
      sha256: digest,
      storageKey: digest,
      sizeBytes: file.bytes.length,
      workpieceKind,
      workpieceState,
    });
    if (!revised) throw new Error("artifact revision could not be applied");
    // The new bytes invalidate any prior preview: regenerate (or clear) it so the
    // embedded PDF preview reflects the revised content, never the old version.
    const revisedWithPreview = await attachOfficePreview(
      { orgId: input.orgId, record: revised, sandboxId: run.sandboxId, sourcePath },
      { regenerate: true },
    );
    const descriptor = toArtifactDescriptor(revisedWithPreview);
    await recordProviderEvent(
      {
        id: `artifact.revised:${revisedWithPreview.id}:${revisedWithPreview.workpieceRevision}`,
        runId: run.id,
        threadId: run.threadId,
        provider: "skynet",
        eventType: "artifact.revised",
        payload: descriptor,
      },
      { critical: true },
    );
    publishOrgChange(input.orgId, {
      type: "artifact",
      action: "updated",
      artifactId: revisedWithPreview.id,
      runId: revisedWithPreview.runId,
      threadId: revisedWithPreview.threadId,
    });
    return { artifact: descriptor, record: revisedWithPreview, created: false };
  }

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
      contentType,
      sizeBytes: file.bytes.length,
      sha256: digest,
      storageKey: digest,
      workpieceKind,
      workpieceState,
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

  // Best-effort Office->PDF preview for a fresh Office binary (skips a re-publish
  // that already carries one). Non-fatal: a missing preview stays download-only.
  const record = await attachOfficePreview(
    { orgId: input.orgId, record: stored.row, sandboxId: run.sandboxId, sourcePath },
    { regenerate: false },
  );
  const descriptor = toArtifactDescriptor(record);
  await recordProviderEvent(
    {
      id: `artifact.created:${record.id}`,
      runId: run.id,
      threadId: run.threadId,
      provider: "skynet",
      eventType: "artifact.created",
      payload: descriptor,
    },
    { critical: true },
  );
  if (stored.created) {
    publishOrgChange(input.orgId, {
      type: "artifact",
      action: "created",
      artifactId: record.id,
      runId: run.id,
      threadId: run.threadId,
    });
  }
  return { artifact: descriptor, record, created: stored.created };
}

export async function resolveArtifactForThread(input: {
  readonly orgId: string;
  readonly threadId: string;
  readonly artifactId: string;
}): Promise<ArtifactRecord | null> {
  const artifact = await getArtifactForOrg(input.orgId, input.artifactId);
  return artifact?.threadId === input.threadId ? artifact : null;
}
