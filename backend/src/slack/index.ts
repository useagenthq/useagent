/**
 * Slack adapter (v1) — env-gated Events-API ingest that maps Slack threads onto
 * runs. Single mount point for src/index.ts; `slackEnabled()` (from ../env)
 * decides whether it wires up at all.
 *
 * Slack app manifest requirements: scopes `app_mentions:read`, `im:history`,
 * `channels:history` + `groups:history` (thread follow), `chat:write`,
 * `reactions:write`, and `assistant:write` for the AI-Apps status shimmer
 * (`assistant.threads.setStatus`); the app must enable the **Agents & AI Apps**
 * feature for the shimmer to render (elsewhere setStatus errors and we silently
 * fall back to 👀-ack + completion post). Event subscriptions: `app_mention`,
 * `message.im` (+ `message.channels`/`message.groups` for thread follow),
 * request URL → POST /api/slack/events. `assistant_thread_started` is NOT
 * required for v1 — it only signals the assistant pane opening (for a greeting /
 * suggested prompts); the user's actual message still arrives as `message.im`
 * and is handled by the DM path, so runs are created without it.
 */
import { slackConfig } from "../env";
import { startSlackOutboxRelay } from "./outbox";
import { startSlackSocketMode } from "./socket-mode";

export { slackRoutes } from "./routes";
export { slackEnabled } from "../env";
export { setSlackClientForTest, type SlackClient } from "./client";
export { stopSlackSocketMode } from "./socket-mode";
export { syncSlackWorkspaceBindings } from "./workspaces";

/** Start the durable outbox delivery relay (boot recovery + interval) and,
 *  when SLACK_APP_TOKEN is set, the Socket Mode ingress (WebSocket lane - no
 *  public URL required; shares the HTTP path's handler + deduper). Called
 *  from src/index.ts only when Slack is configured. No-op if unconfigured. */
export function startSlackOutbox(): void {
  const cfg = slackConfig();
  if (!cfg) return;
  startSlackOutboxRelay(cfg);
  startSlackSocketMode();
}
