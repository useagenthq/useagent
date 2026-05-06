import type { RunStatus } from "../db/schema";

/**
 * Compose the text of a run's Slack reply from its terminal outcome. A completed
 * run posts its summary (or "Done." when empty); a failed run posts a warning
 * with the failure reason. Extracted so run finalization (runs/finalize.ts) can
 * compose the SAME reply the watcher used to, now durably + transactionally.
 */
export function composeSlackReplyText(status: RunStatus, summary: string | null): string {
  return status === "completed"
    ? summary?.trim() || "Done."
    : `:warning: Run failed${summary ? `: ${summary}` : "."}`;
}
