/**
 * Minimal Slack Web API client. The durable outbox (src/slack/outbox) drives the
 * two delivery calls (`postMessage` reply, `addReaction` receipt) and needs to
 * KNOW the outcome to retry/backoff/dead-letter, so those return a classified
 * {@link DeliveryResult} instead of swallowing. `setAssistantStatus` is the live
 * shimmer — best-effort and NOT durable, so it still swallows.
 *
 * A module-level override (`setSlackClientForTest`) lets tests record calls (and
 * simulate 429 / errors) instead of hitting the network.
 */
import type { SlackConfig } from "../env";

/** Outcome of a single Slack delivery attempt — drives the outbox state machine. */
export type DeliveryResult =
  | { ok: true }
  | { ok: false; class: "rate_limited"; retryAfterMs: number; message: string }
  | { ok: false; class: "transient"; message: string }
  | { ok: false; class: "permanent"; message: string };

export interface SlackClient {
  /** Post a message; `threadTs` keeps every reply inside the Slack thread. */
  postMessage(args: { channel: string; text: string; threadTs?: string }): Promise<DeliveryResult>;
  /** Add a reaction emoji (name without colons) to a specific message. */
  addReaction(args: { channel: string; timestamp: string; name: string }): Promise<DeliveryResult>;
  /**
   * Slack AI-Apps assistant status — the shimmering "Starting up…" line. Empty
   * `status` clears it. Best-effort: non-assistant contexts error and are
   * swallowed, so callers fire it unconditionally. NOT routed through the outbox.
   */
  setAssistantStatus(args: { channel: string; threadTs: string; status: string }): Promise<void>;
}

/** Slack `error` strings that will never succeed on retry → dead-letter fast. */
const PERMANENT_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "msg_too_long",
  "no_text",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "missing_scope",
  "not_authed",
  "restricted_action",
  "invalid_arguments",
]);

/** Real client: thin `fetch` wrapper that classifies the Slack response. */
export function httpSlackClient(config: SlackConfig): SlackClient {
  async function call(method: string, params: Record<string, unknown>): Promise<DeliveryResult> {
    try {
      const res = await fetch(`${config.apiUrl}${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(params),
      });
      // HTTP-level rate limit — honor Retry-After (seconds).
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after") ?? "1");
        return {
          ok: false,
          class: "rate_limited",
          retryAfterMs: (Number.isFinite(ra) && ra > 0 ? ra : 1) * 1000,
          message: "http_429",
        };
      }
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (data.ok) return { ok: true };
      const err = data.error ?? String(res.status);
      // App-level rate limit is also possible with a 200 body.
      if (err === "ratelimited" || err === "rate_limited") {
        return { ok: false, class: "rate_limited", retryAfterMs: 1000, message: err };
      }
      return {
        ok: false,
        class: PERMANENT_ERRORS.has(err) ? "permanent" : "transient",
        message: err,
      };
    } catch (err) {
      // Network / DNS / timeout — retryable.
      return { ok: false, class: "transient", message: (err as Error).message };
    }
  }

  return {
    postMessage: ({ channel, text, threadTs }) =>
      call("chat.postMessage", {
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        unfurl_links: false,
        unfurl_media: false,
      }),
    addReaction: ({ channel, timestamp, name }) =>
      call("reactions.add", { channel, timestamp, name }),
    setAssistantStatus: async ({ channel, threadTs, status }) => {
      // Best-effort shimmer: swallow the classified result.
      await call("assistant.threads.setStatus", {
        channel_id: channel,
        thread_ts: threadTs,
        status,
      });
    },
  };
}

let override: SlackClient | null = null;

/** TEST ONLY: swap in a recording client so no request hits Slack. */
export function setSlackClientForTest(client: SlackClient | null): void {
  override = client;
}

/** Resolve the active client: the test override, else a real one for `config`. */
export function resolveSlackClient(config: SlackConfig): SlackClient {
  return override ?? httpSlackClient(config);
}
