import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { artifacts } from "../db/schema";

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
}): Promise<{ row: ArtifactRecord; created: boolean }> {
  const [inserted] = await db
    .insert(artifacts)
    .values(input)
    .onConflictDoNothing({
      target: [artifacts.runId, artifacts.sourcePath, artifacts.sha256],
    })
    .returning();
  if (inserted) return { row: inserted, created: true };

  const [existing] = await db
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
  return { row: existing, created: false };
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
