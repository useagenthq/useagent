import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import {
  artifacts,
  type ArtifactWorkpieceKind,
  type ArtifactWorkpieceState,
} from "../db/schema";
import { inferWorkpieceKind } from "./workpiece";

export type ArtifactRecord = typeof artifacts.$inferSelect;

export interface ArtifactDescriptor {
  readonly id: string;
  readonly run_id: string;
  readonly thread_id: string;
  readonly name: string;
  readonly source_path: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly created_at: string;
  readonly preview_url: string;
  readonly download_url: string;
  readonly workpiece: ArtifactWorkpieceDescriptor | null;
}

export interface ArtifactWorkpieceDescriptor {
  readonly kind: ArtifactWorkpieceKind;
  readonly source_version: string;
  readonly state_revision: number;
  readonly state_url: string;
  readonly actions: readonly ["preview", "download", "edit"];
}

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
    workpiece: row.workpieceKind
      ? {
          kind: row.workpieceKind,
          source_version: row.sha256,
          state_revision: row.workpieceRevision,
          state_url: `/api/artifacts/${row.id}/workpiece`,
          actions: ["preview", "download", "edit"],
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
      .where(and(eq(artifacts.id, existing.id), isNull(artifacts.workpieceState)))
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
    if (JSON.stringify(current.workpieceState) !== JSON.stringify(input.workpieceState)) {
      throw new Error("artifact editable companion conflicts with the existing publication");
    }
    return { row: current, created: false };
  }
  if (
    input.workpieceState &&
    JSON.stringify(existing.workpieceState) !== JSON.stringify(input.workpieceState)
  ) {
    throw new Error("artifact editable companion conflicts with the existing publication");
  }
  return { row: existing, created: false };
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

export async function getArtifact(id: string): Promise<ArtifactRecord | null> {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
  return row ?? null;
}

export async function getArtifactForOrg(
  orgId: string,
  id: string,
): Promise<ArtifactRecord | null> {
  const [row] = await db
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
