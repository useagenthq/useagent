/**
 * Durable snapshot store for the sandbox memory file (`~/.skynet/memory.md`).
 *
 * Each row is one thread's memory-file BODY captured at task end, keyed by its
 * team-memory pool partition (team_id + pool_user_id). Restore reads "the latest
 * body for this pool" straight from Postgres, so a new session in the same pool
 * sees a just-taught fact IMMEDIATELY — no wait for the Tencent side to distill
 * it into search recall. This is the cross-session continuity old skynet promised.
 *
 * Isolation mirrors src/memory/scope.ts exactly: a run captures into its WRITE
 * pool and restores from its READ pools, so personal content never leaks into the
 * shared org pool and org facts fan out to every member.
 */
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { memoryFiles } from "../db/schema";
import type { MemoryScope } from "../db/schema";
import type { ScopedBody } from "./memory-file";

/** Cap on a stored body (defensive; the digest that produced it is already
 *  bounded ~4KB, but the agent may have written more into its file). */
const CONTENT_CAP = 16_384;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** One pool to look a snapshot up in — the partition keys + its scope label. */
export interface SnapshotPool {
  readonly teamId: string;
  readonly poolUserId: string;
  readonly scope: MemoryScope;
}

/**
 * Persist a run's captured memory-file body into its write pool, AT MOST once per
 * run. No-op (returns false) when the pool's latest snapshot already carries this
 * exact content — so an unchanged file (the agent never edited it) never creates
 * a duplicate row, and a re-finalized run is idempotent (id = `mf_${runId}`).
 * Returns true when a new snapshot was written.
 */
export async function saveMemoryFileSnapshot(input: {
  runId: string;
  threadId: string;
  pool: SnapshotPool;
  content: string;
}): Promise<boolean> {
  const content = input.content.slice(0, CONTENT_CAP);
  const contentHash = sha256(content);

  const latest = await latestSnapshotRow(input.pool.teamId, input.pool.poolUserId);
  if (latest?.contentHash === contentHash) return false; // unchanged → nothing new to persist

  const inserted = await db
    .insert(memoryFiles)
    .values({
      id: `mf_${input.runId}`,
      teamId: input.pool.teamId,
      poolUserId: input.pool.poolUserId,
      scope: input.pool.scope,
      threadId: input.threadId,
      runId: input.runId,
      content,
      contentHash,
    })
    .onConflictDoNothing({ target: memoryFiles.id })
    .returning({ id: memoryFiles.id });
  return inserted.length > 0;
}

/** The most recent snapshot row for one pool partition (newest by created_at). */
async function latestSnapshotRow(
  teamId: string,
  poolUserId: string,
): Promise<{ content: string; contentHash: string } | null> {
  const [row] = await db
    .select({ content: memoryFiles.content, contentHash: memoryFiles.contentHash })
    .from(memoryFiles)
    .where(and(eq(memoryFiles.teamId, teamId), eq(memoryFiles.poolUserId, poolUserId)))
    .orderBy(desc(memoryFiles.createdAt), desc(memoryFiles.id))
    .limit(1);
  return row ?? null;
}

/**
 * Latest durable body for each read pool, in the pools' priority order (personal
 * first), skipping pools with no snapshot. The restore digest builder merges +
 * dedupes these into the file it writes into a fresh sandbox.
 */
export async function latestMemoryFilesForPools(
  pools: readonly SnapshotPool[],
): Promise<ScopedBody[]> {
  const out: ScopedBody[] = [];
  for (const pool of pools) {
    const row = await latestSnapshotRow(pool.teamId, pool.poolUserId);
    if (row && row.content.trim()) out.push({ scope: pool.scope, body: row.content });
  }
  return out;
}
