import { deleteExpiredReadyUploads } from "./repo";
import { reclaimUnreferencedLocalArtifacts } from "../artifacts/reclaim";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export async function cleanupExpiredUploads(now: Date = new Date()): Promise<number> {
  return deleteExpiredReadyUploads(now);
}

export async function cleanupExpiredUploadStorage(now: Date = new Date()): Promise<{
  readonly expiredUploads: number;
  readonly reclaimedArtifacts: number;
}> {
  const expiredUploads = await cleanupExpiredUploads(now);
  const reclaimed = await reclaimUnreferencedLocalArtifacts({ now });
  return { expiredUploads, reclaimedArtifacts: reclaimed.removed.length };
}

/** Hourly metadata cleanup for abandoned pre-run uploads. Claimed inputs are
 * retained with their run. The subsequent reference scan reclaims only local
 * content-addressed bytes that are at least 24 hours old and absent from both
 * artifact and upload metadata. The unref'd timer cannot keep a process alive. */
export function startUploadCleanup(): void {
  if (timer) return;
  const cleanup = () =>
    cleanupExpiredUploadStorage().catch((error) => {
      console.error("[uploads] lifecycle cleanup failed:", error);
    });
  void cleanup();
  timer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  timer.unref?.();
}
