import { and, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import {
  ARTIFACT_LEGACY_WORKPIECE_ACTIONS,
  artifactWorkpieceExports,
  type ArtifactDescriptor,
  type ArtifactWorkpieceDescriptor,
  type ArtifactWorkpieceKind,
  type ArtifactWorkpieceState,
} from "@useagent/artifact-workspace";
import { artifacts } from "../db/schema";
import { stableJson } from "../github/publication-repo-input";
import { type ArtifactListCursor, encodeArtifactCursor } from "./list-cursor";
import { inferWorkpieceKind } from "./workpiece";

export type ArtifactRecord = typeof artifacts.$inferSelect;
export type { ArtifactDescriptor, ArtifactWorkpieceDescriptor } from "@useagent/artifact-workspace";

export function toArtifactDescriptor(row: ArtifactRecord): ArtifactDescriptor {
  const content = `/api/artifacts/${row.id}/content`;
  return {
    id: row.id,
    run_id: row.runId,
    thread_id: row.threadId,
    name: row.name,
    source_path: row.sourcePath,
    content_type: row.contentType,
    size_bytes: row.sizeBytes,
    sha256: row.sha256,
    created_at: row.createdAt.toISOString(),
    preview_url: content,
    download_url: `${content}?download=1`,
    preview_pdf_url: row.previewStorageKey
      ? `/api/artifacts/${row.id}/preview?v=${row.previewStorageKey}`
      : null,
    workpiece: row.workpieceKind
      ? {
          kind: row.workpieceKind,
          source_version: row.sha256,
          state_revision: row.workpieceRevision,
          state_url: `/api/artifacts/${row.id}/workpiece`,
          export_url: `/api/artifacts/${row.id}/workpiece/export`,
          exports: artifactWorkpieceExports(row.workpieceKind),
          actions: ARTIFACT_LEGACY_WORKPIECE_ACTIONS,
        }
      : null,
  };
}

export async function createArtifactRecord(input: {
  readonly orgId: string;
  readonly userId: string | null;
  readonly runId: string;
  readonly threadId: string;
  readonly sourcePath: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly workpieceKind?: ArtifactWorkpieceKind | null;
  readonly workpieceState?: ArtifactWorkpieceState | null;
}, exec: Executor = db): Promise<{ row: ArtifactRecord; created: boolean }> {
  const workpieceKind =
    input.workpieceKind ?? inferWorkpieceKind(input.name, input.contentType, input.sizeBytes);
  const [inserted] = await exec
    .insert(artifacts)
    .values({ ...input, workpieceKind })
    .onConflictDoNothing({
      target: [artifacts.runId, artifacts.sourcePath, artifacts.sha256],
    })
    .returning();
  if (inserted) return { row: inserted, created: true };

  const [existing] = await exec
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.runId, input.runId),
        eq(artifacts.sourcePath, input.sourcePath),
        eq(artifacts.sha256, input.sha256),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("artifact idempotency conflict could not be resolved");
  if (input.workpieceState && !existing.workpieceState) {
    const [seeded] = await exec
      .update(artifacts)
      .set({
        workpieceKind,
        workpieceState: input.workpieceState,
      })
      .where(and(
        eq(artifacts.id, existing.id),
        eq(artifacts.sha256, existing.sha256),
        eq(artifacts.workpieceRevision, existing.workpieceRevision),
        isNull(artifacts.workpieceState),
      ))
      .returning();
    if (seeded) return { row: seeded, created: false };

    // Another idempotent publisher may have won the null-to-state transition.
    // Re-read before comparing so equal concurrent companions converge rather
    // than failing against the stale row selected above.
    const [current] = await exec
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, existing.id))
      .limit(1);
    if (!current) throw new Error("artifact idempotency conflict disappeared");
    if (
      current.sha256 !== existing.sha256 ||
      current.workpieceRevision !== existing.workpieceRevision
    ) {
      throw new Error("artifact changed while its editable companion was being attached");
    }
    if (stableJson(current.workpieceState) !== stableJson(input.workpieceState)) {
      throw new Error("artifact editable companion conflicts with the existing publication");
    }
    return { row: current, created: false };
  }
  if (
    input.workpieceState &&
    stableJson(existing.workpieceState) !== stableJson(input.workpieceState)
  ) {
    throw new Error("artifact editable companion conflicts with the existing publication");
  }
  return { row: existing, created: false };
}

export async function getArtifactForRunSourcePath(
  runId: string,
  sourcePath: string,
  exec: Executor = db,
): Promise<ArtifactRecord | null> {
  const [row] = await exec
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.runId, runId), eq(artifacts.sourcePath, sourcePath)))
    .limit(1);
  return row ?? null;
}

export async function updateArtifactWorkpiece(input: {
  readonly orgId: string;
  readonly id: string;
  readonly expectedRevision: number;
  readonly state: ArtifactWorkpieceState;
}): Promise<ArtifactRecord | null> {
  const [updated] = await db
    .update(artifacts)
    .set({
      workpieceState: input.state,
      workpieceRevision: sql`${artifacts.workpieceRevision} + 1`,
    })
    .where(
      and(
        eq(artifacts.orgId, input.orgId),
        eq(artifacts.id, input.id),
        eq(artifacts.workpieceRevision, input.expectedRevision),
      ),
    )
    .returning();
  return updated ?? null;
}

/** Repair an older native Office artifact that was published before the control
 * plane imported binary bytes into canonical editor state. Initial hydration is
 * a null-to-state transition, so it keeps revision 0 and cannot overwrite a
 * user-authored or concurrently repaired state. */
export async function seedArtifactWorkpieceStateIfMissing(input: {
  readonly orgId: string;
  readonly id: string;
  readonly kind: ArtifactWorkpieceKind;
  readonly state: ArtifactWorkpieceState;
}): Promise<ArtifactRecord | null> {
  const [updated] = await db
    .update(artifacts)
    .set({ workpieceState: input.state })
    .where(
      and(
        eq(artifacts.orgId, input.orgId),
        eq(artifacts.id, input.id),
        eq(artifacts.workpieceKind, input.kind),
        isNull(artifacts.workpieceState),
      ),
    )
    .returning();
  return updated ?? null;
}

/** Persist a structural PDF page operation as a new revision of the same
 * artifact. Page ops replace the immutable source bytes (new digest + storage
 * key + size) and bump the revision under optimistic concurrency, keeping the
 * stable artifact id so existing preview/download references still resolve. */
export async function applyArtifactPdfPageRevision(input: {
  readonly orgId: string;
  readonly id: string;
  readonly expectedRevision: number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly exec?: Executor;
}): Promise<ArtifactRecord | null> {
  const [updated] = await (input.exec ?? db)
    .update(artifacts)
    .set({
      sha256: input.sha256,
      storageKey: input.storageKey,
      sizeBytes: input.sizeBytes,
      previewStorageKey: null,
      workpieceRevision: sql`${artifacts.workpieceRevision} + 1`,
    })
    .where(
      and(
        eq(artifacts.orgId, input.orgId),
        eq(artifacts.id, input.id),
        eq(artifacts.workpieceRevision, input.expectedRevision),
      ),
    )
    .returning();
  return updated ?? null;
}

/** Land a republished file as a NEW REVISION of an existing artifact rather than a
 * new artifact: replace the immutable content (new digest + storage key + size +
 * content type + name) and its editable workpiece state, and bump the revision so
 * a regenerated deliverable shows as one tab with history. The stable artifact id
 * is kept so existing preview/download references still resolve. The revision bump
 * is a plain mainline advance (like a human save), so any proposal authored against
 * the old base_revision conflicts on accept exactly as it would after a human edit. */
export async function reviseArtifactPublication(input: {
  readonly orgId: string;
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly sha256: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly workpieceKind: ArtifactWorkpieceKind | null;
  readonly workpieceState: ArtifactWorkpieceState | null;
  readonly exec?: Executor;
}): Promise<ArtifactRecord | null> {
  const [updated] = await (input.exec ?? db)
    .update(artifacts)
    .set({
      name: input.name,
      contentType: input.contentType,
      sha256: input.sha256,
      storageKey: input.storageKey,
      sizeBytes: input.sizeBytes,
      workpieceKind: input.workpieceKind,
      workpieceState: input.workpieceState,
      previewStorageKey: null,
      workpieceRevision: sql`${artifacts.workpieceRevision} + 1`,
    })
    .where(and(eq(artifacts.orgId, input.orgId), eq(artifacts.id, input.id)))
    .returning();
  return updated ?? null;
}

/** Attach (or clear) a rendered-PDF preview storage key on an artifact. Best-effort
 * metadata; org-scoped, and it never touches content identity or the revision. */
export async function updateArtifactPreview(input: {
  readonly orgId: string;
  readonly id: string;
  readonly expectedSha256: string;
  readonly expectedWorkpieceRevision: number;
  readonly previewStorageKey: string | null;
  readonly exec?: Executor;
}): Promise<ArtifactRecord | null> {
  const [updated] = await (input.exec ?? db)
    .update(artifacts)
    .set({ previewStorageKey: input.previewStorageKey })
    .where(and(
      eq(artifacts.orgId, input.orgId),
      eq(artifacts.id, input.id),
      eq(artifacts.sha256, input.expectedSha256),
      eq(artifacts.workpieceRevision, input.expectedWorkpieceRevision),
    ))
    .returning();
  return updated ?? null;
}

export async function getArtifact(id: string): Promise<ArtifactRecord | null> {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
  return row ?? null;
}

/** The first artifact in the org whose bytes have this digest, or null. Used to
 * dedupe content-addressed image assets extracted from a deck import so a
 * republish/reimport of the same picture reuses the existing artifact. */
export async function findArtifactByOrgAndSha256(
  orgId: string,
  sha256: string,
  exec: Executor = db,
): Promise<ArtifactRecord | null> {
  const [row] = await exec
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), eq(artifacts.sha256, sha256)))
    .limit(1);
  return row ?? null;
}

export async function getArtifactForOrg(
  orgId: string,
  id: string,
  exec: Executor = db,
): Promise<ArtifactRecord | null> {
  const [row] = await exec
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.orgId, orgId), eq(artifacts.id, id)))
    .limit(1);
  return row ?? null;
}

export async function listArtifactsForOrg(input: {
  readonly orgId: string;
  readonly runId?: string;
  readonly threadId?: string;
  readonly limit?: number;
}): Promise<ArtifactRecord[]> {
  const filters = [eq(artifacts.orgId, input.orgId)];
  if (input.runId) filters.push(eq(artifacts.runId, input.runId));
  if (input.threadId) filters.push(eq(artifacts.threadId, input.threadId));
  return db
    .select()
    .from(artifacts)
    .where(and(...filters))
    .orderBy(desc(artifacts.createdAt))
    .limit(Math.max(1, Math.min(input.limit ?? 100, 100)));
}

export interface ArtifactListPage {
  readonly artifacts: ArtifactRecord[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

/**
 * One page of the org's artifacts (optionally one run's or one thread's),
 * newest first with the id breaking ties, starting after `cursor`. A keyset
 * page: an artifact published while someone pages lands on the newest page and
 * never shifts the later ones. One row past `limit` is read to know whether
 * another page follows.
 */
export async function listArtifactPageForOrg(input: {
  readonly orgId: string;
  readonly runId?: string;
  readonly threadId?: string;
  readonly limit: number;
  readonly cursor: ArtifactListCursor | null;
}): Promise<ArtifactListPage> {
  const limit = Math.max(1, Math.min(input.limit, 100));
  const filters = [eq(artifacts.orgId, input.orgId)];
  if (input.runId) filters.push(eq(artifacts.runId, input.runId));
  if (input.threadId) filters.push(eq(artifacts.threadId, input.threadId));
  if (input.cursor) {
    filters.push(sql`(${artifacts.createdAt}, ${artifacts.id}) < (${input.cursor.createdAt}::timestamptz, ${input.cursor.id}::uuid)`);
  }
  const rows = await db
    .select({ ...getTableColumns(artifacts), cursorCreatedAt: sql<string>`${artifacts.createdAt}::text` })
    .from(artifacts)
    .where(and(...filters))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    artifacts: page.map(({ cursorCreatedAt: _cursorCreatedAt, ...row }) => row),
    nextCursor: rows.length > limit && last ? encodeArtifactCursor({ createdAt: last.cursorCreatedAt, id: last.id }) : null,
  };
}

/** Every artifact of one run, newest first, with only the columns an archive
 * reads. Not capped: the archive bounds the total bytes it will read, so no
 * file is left out silently. */
export async function listRunArtifactFilesForOrg(input: {
  readonly orgId: string;
  readonly runId: string;
}): Promise<Pick<ArtifactRecord, "name" | "sizeBytes" | "storageKey">[]> {
  return db
    .select({
      name: artifacts.name,
      sizeBytes: artifacts.sizeBytes,
      storageKey: artifacts.storageKey,
    })
    .from(artifacts)
    .where(and(eq(artifacts.orgId, input.orgId), eq(artifacts.runId, input.runId)))
    .orderBy(desc(artifacts.createdAt));
}
