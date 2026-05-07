import type { RunStatus } from "../db/schema";
import { toSlackMrkdwn } from "./mrkdwn";

/**
 * Compose the text of a run's Slack reply from its terminal outcome. A completed
 * run posts its summary (or "Done." when empty); a failed run posts a warning
 * with the failure reason. Extracted so run finalization (runs/finalize.ts) can
 * compose the SAME reply the watcher used to, now durably + transactionally.
 *
 * The summary is an agent reply in Markdown; Slack message text uses mrkdwn, so
 * convert it here - the single place the final reply text is composed before it
 * is enqueued to the durable outbox, so the conversion happens exactly ONCE.
 */
export function composeSlackReplyText(status: RunStatus, summary: string | null): string {
  const body = summary?.trim() ? toSlackMrkdwn(summary.trim()) : "";
  return status === "completed"
    ? body || "Done."
    : `:warning: Run failed${body ? `: ${body}` : "."}`;
}
