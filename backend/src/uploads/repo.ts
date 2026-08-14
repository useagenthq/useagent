import { and, asc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { userUploads } from "../db/schema";

export type UserUploadRecord = typeof userUploads.$inferSelect;

export interface UserUploadDescriptor {
  readonly id: string;
  readonly name: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly created_at: string;
  readonly download_url: string;
}

export class UploadClaimError extends Error {
  readonly code = "upload_unavailable";

  constructor() {
    super("one or more uploads are unavailable");
    this.name = "UploadClaimError";
  }
}

export function toUserUploadDescriptor(row: UserUploadRecord): UserUploadDescriptor {
  return {
    id: row.id,
    name: row.name,
    content_type: row.contentType,
    size_bytes: row.sizeBytes,
    sha256: row.sha256,
    created_at: row.createdAt.toISOString(),
    download_url: `/api/uploads/${row.id}/content`,
  };
}

export async function createUserUpload(input: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly expiresAt: Date;
}): Promise<UserUploadRecord> {
  const [row] = await db.insert(userUploads).values(input).returning();
  if (!row) throw new Error("upload record was not created");
  return row;
}

export async function getOwnedUpload(
  orgId: string,
  userId: string,
  id: string,
): Promise<UserUploadRecord | null> {
  const [row] = await db
    .select()
    .from(userUploads)
    .where(
      and(
        eq(userUploads.id, id),
        eq(userUploads.orgId, orgId),
        eq(userUploads.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function deleteReadyUpload(
  orgId: string,
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(userUploads)
    .where(
      and(
        eq(userUploads.id, id),
        eq(userUploads.orgId, orgId),
        eq(userUploads.userId, userId),
        isNull(userUploads.runId),
      ),
    )
    .returning({ id: userUploads.id });
  return rows.length === 1;
}

/** Remove only expired uploads that were never claimed by a run. The backing
 * bytes are content-addressed and may be shared by an artifact or another
 * tenant's upload, so metadata cleanup intentionally does not delete blobs. */
export async function deleteExpiredReadyUploads(now: Date = new Date()): Promise<number> {
  const rows = await db
    .delete(userUploads)
    .where(and(isNull(userUploads.runId), lte(userUploads.expiresAt, now)))
    .returning({ id: userUploads.id });
  return rows.length;
}

/** Atomically bind every selected upload to the accepted run. The guarded
 * update makes concurrent reuse impossible; a partial match throws inside the
 * caller's transaction, rolling back both the claims and run creation. */
export async function claimUploadsForRun(
  input: {
    readonly ids: readonly string[];
    readonly orgId: string;
    readonly userId: string;
    readonly runId: string;
  },
  exec: Executor,
): Promise<void> {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) return;
  const claimed = await exec
    .update(userUploads)
    .set({ runId: input.runId })
    .where(
      and(
        inArray(userUploads.id, ids),
        eq(userUploads.orgId, input.orgId),
        eq(userUploads.userId, input.userId),
        isNull(userUploads.runId),
        gt(userUploads.expiresAt, new Date()),
      ),
    )
    .returning({ id: userUploads.id });
  if (claimed.length !== ids.length) throw new UploadClaimError();
}

export async function listRunUploads(runId: string): Promise<UserUploadRecord[]> {
  return db
    .select()
    .from(userUploads)
    .where(eq(userUploads.runId, runId))
    .orderBy(asc(userUploads.createdAt));
}
