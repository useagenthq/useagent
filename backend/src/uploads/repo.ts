import { and, asc, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { RunUpload } from "@useagent/agent-client/wire";
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

/** Compact inbound-attachment descriptor rendered on a run's user turn - the wire
 * `RunUpload`: no storage key / sha / expiry, only what the timeline needs to show
 * the attachment and fetch its bytes from the content route. */
export type RunUploadDescriptor = RunUpload;

export function toRunUploadDescriptor(row: UserUploadRecord): RunUploadDescriptor {
  return {
    id: row.id,
    name: row.name,
    content_type: row.contentType,
    size_bytes: row.sizeBytes,
    created_at: row.createdAt.toISOString(),
  };
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

/** Atomically bind one ready upload to the accepted run and return the claimed
 * row. Call from the same transaction that creates the consuming record so a
 * rollback releases the claim and a concurrent caller cannot reuse the bytes. */
export async function claimUploadForRun(
  input: {
    readonly id: string;
    readonly orgId: string;
    readonly userId: string;
    readonly runId: string;
  },
  exec: Executor,
): Promise<UserUploadRecord> {
  const [claimed] = await exec
    .update(userUploads)
    .set({ runId: input.runId })
    .where(
      and(
        eq(userUploads.id, input.id),
        eq(userUploads.orgId, input.orgId),
        eq(userUploads.userId, input.userId),
        isNull(userUploads.runId),
        gt(userUploads.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!claimed) throw new UploadClaimError();
  return claimed;
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

/** Inbound attachments for a SET of runs, batched into one query and grouped by
 * run id (oldest-first within each run). Powers the compact `uploads` array the
 * thread/run payload carries so the timeline needs no extra round trip. */
export async function listUploadsForRuns(
  runIds: readonly string[],
): Promise<Map<string, RunUploadDescriptor[]>> {
  const byRun = new Map<string, RunUploadDescriptor[]>();
  if (runIds.length === 0) return byRun;
  const rows = await db
    .select()
    .from(userUploads)
    .where(inArray(userUploads.runId, [...new Set(runIds)]))
    .orderBy(asc(userUploads.createdAt));
  for (const row of rows) {
    if (!row.runId) continue;
    const list = byRun.get(row.runId) ?? [];
    list.push(toRunUploadDescriptor(row));
    byRun.set(row.runId, list);
  }
  return byRun;
}

/** An upload ALREADY CLAIMED by a run, scoped to the org (any org member viewing
 * the thread can fetch the inbound image, matching the artifact content route's
 * org-scope). Unclaimed (draft) uploads stay user-private and resolve via
 * getOwnedUpload instead. Returns null (-> 404) for a cross-org or unclaimed id. */
export async function getOrgRunUpload(
  orgId: string,
  id: string,
): Promise<UserUploadRecord | null> {
  const [row] = await db
    .select()
    .from(userUploads)
    .where(
      and(
        eq(userUploads.id, id),
        eq(userUploads.orgId, orgId),
        isNotNull(userUploads.runId),
      ),
    )
    .limit(1);
  return row ?? null;
}
