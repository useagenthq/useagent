import { deleteExpiredReadyUploads } from "./repo";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export async function cleanupExpiredUploads(now: Date = new Date()): Promise<number> {
  return deleteExpiredReadyUploads(now);
}

/** Hourly metadata cleanup for abandoned pre-run uploads. Claimed inputs are
 * retained with their run, and shared content-addressed bytes are never
 * removed here. The unref'd timer cannot keep a process alive. */
export function startUploadCleanup(): void {
  if (timer) return;
  timer = setInterval(() => {
    void cleanupExpiredUploads().catch((error) => {
      console.error("[uploads] expired metadata cleanup failed:", error);
    });
  }, CLEANUP_INTERVAL_MS);
  timer.unref?.();
}
