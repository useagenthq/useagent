/**
 * Minimal Slack Web API client. The durable outbox (src/slack/outbox) drives
 * Slack delivery and needs to KNOW each outcome to retry/backoff/dead-letter, so
 * these methods return a classified {@link DeliveryResult} instead of swallowing.
 *
 * A module-level override (`setSlackClientForTest`) lets tests record calls (and
 * simulate 429 / errors) instead of hitting the network.
 */
import type { SlackConfig } from "../env";
import type { SlackSessionStatus, SlackStreamChunk, SlackStreamTaskDisplayMode } from "./streaming";

/** Outcome of a single Slack delivery attempt — drives the outbox state machine.
 *  A successful post/update carries the message `ts` (Slack's `message.ts`) so a
 *  card post can persist it for later `chat.update`s; undefined for calls with no
 *  message identity (reactions) or a client that does not surface it. */
export type DeliveryResult =
  | { ok: true; ts?: string }
  | { ok: false; class: "rate_limited"; retryAfterMs: number; message: string }
  | { ok: false; class: "transient"; message: string }
  | { ok: false; class: "permanent"; message: string };

export interface SlackClient {
  /** Post a message; `threadTs` keeps every reply inside the Slack thread.
   *  `blocks` posts Block Kit (the run card); `text` stays the notification /
   *  fallback string. A successful post returns the message `ts`. */
  postMessage(args: {
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: readonly unknown[];
  }): Promise<DeliveryResult>;
  /** Update an existing message IN PLACE (chat.update) by its `ts` - advances a
   *  run card's status/answer without posting a new message. */
  updateMessage(args: {
    channel: string;
    ts: string;
    text: string;
    blocks?: readonly unknown[];
  }): Promise<DeliveryResult>;
  /** Add a reaction emoji (name without colons) to a specific message. */
  addReaction(args: { channel: string; timestamp: string; name: string }): Promise<DeliveryResult>;
  /**
   * Upload a file into a thread. Ported from the QM bot (files.uploadV2,
   * reference-eval src/slack/attachments.ts:189) and reference-bot (files_upload_v2,
   * client.py:354) - both use the Slack SDK's uploadV2 helper. skynet has NO
   * Slack SDK by design (thin fetch client), so we perform the identical
   * sequence uploadV2 wraps: files.getUploadURLExternal -> POST the bytes to the
   * returned URL -> files.completeUploadExternal (which shares it into
   * `threadTs`). Returns a classified DeliveryResult so the outbox retries.
   */
  uploadFile(args: {
    channel: string;
    threadTs?: string;
    filename: string;
    title?: string;
    initialComment?: string;
    bytes: Uint8Array;
  }): Promise<DeliveryResult>;
  /** Slack AI Apps session state. `processing` shows the native loading UX;
   * `active` clears it. */
  setSessionStatus(args: {
    channel: string;
    threadTs: string;
    status: SlackSessionStatus;
  }): Promise<DeliveryResult>;
  /** Start a Slack-native streaming reply. Blocks are intentionally not
   * accepted here; Slack only allows blocks at stopStream. */
  startStream(args: {
    channel: string;
    threadTs: string;
    taskDisplayMode: SlackStreamTaskDisplayMode;
    chunks: readonly SlackStreamChunk[];
  }): Promise<DeliveryResult>;
  appendStream(args: {
    channel: string;
    threadTs: string;
    messageTs: string;
    chunks: readonly SlackStreamChunk[];
  }): Promise<DeliveryResult>;
  stopStream(args: {
    channel: string;
    threadTs: string;
    messageTs: string;
    chunks: readonly SlackStreamChunk[];
    blocks?: readonly unknown[];
  }): Promise<DeliveryResult>;
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
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        ts?: string;
      };
      if (data.ok) return typeof data.ts === "string" ? { ok: true, ts: data.ts } : { ok: true };
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
    postMessage: ({ channel, text, threadTs, blocks }) =>
      call("chat.postMessage", {
        channel,
        text,
        ...(blocks ? { blocks } : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
        unfurl_links: false,
        unfurl_media: false,
      }),
    updateMessage: ({ channel, ts, text, blocks }) =>
      call("chat.update", {
        channel,
        ts,
        text,
        ...(blocks ? { blocks } : {}),
      }),
    addReaction: ({ channel, timestamp, name }) =>
      call("reactions.add", { channel, timestamp, name }),
    setSessionStatus: ({ channel, threadTs, status }) =>
      call("agents.sessions.setStatus", {
        channel_id: channel,
        thread_ts: threadTs,
        status,
      }),
    startStream: ({ channel, threadTs, taskDisplayMode, chunks }) =>
      call("chat.startStream", {
        channel,
        thread_ts: threadTs,
        task_display_mode: taskDisplayMode,
        chunks,
      }),
    appendStream: ({ channel, threadTs, messageTs, chunks }) =>
      call("chat.appendStream", {
        channel,
        thread_ts: threadTs,
        message_ts: messageTs,
        chunks,
      }),
    stopStream: ({ channel, threadTs, messageTs, chunks, blocks }) =>
      call("chat.stopStream", {
        channel,
        thread_ts: threadTs,
        message_ts: messageTs,
        chunks,
        ...(blocks ? { blocks } : {}),
      }),
    uploadFile: async ({ channel, threadTs, filename, title, initialComment, bytes }) => {
      const auth = `Bearer ${config.botToken}`;
      const rateLimited = (res: Response): DeliveryResult => {
        const ra = Number(res.headers.get("retry-after") ?? "1");
        return {
          ok: false,
          class: "rate_limited",
          retryAfterMs: (Number.isFinite(ra) && ra > 0 ? ra : 1) * 1000,
          message: "http_429",
        };
      };
      const classify = (err: string): DeliveryResult =>
        err === "ratelimited" || err === "rate_limited"
          ? { ok: false, class: "rate_limited", retryAfterMs: 1000, message: err }
          : { ok: false, class: PERMANENT_ERRORS.has(err) ? "permanent" : "transient", message: err };
      try {
        // 1) Reserve an upload URL. This method requires form-encoding.
        const getRes = await fetch(`${config.apiUrl}files.getUploadURLExternal`, {
          method: "POST",
          headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ filename, length: String(bytes.length) }),
        });
        if (getRes.status === 429) return rateLimited(getRes);
        const g = (await getRes.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          upload_url?: string;
          file_id?: string;
        };
        if (!g.ok || !g.upload_url || !g.file_id) return classify(g.error ?? String(getRes.status));
        // 2) Upload the bytes to the pre-signed URL (multipart; the URL is
        //    pre-authorized, so it carries no bot token).
        const form = new FormData();
        form.append("file", new Blob([bytes]), filename);
        const upRes = await fetch(g.upload_url, { method: "POST", body: form });
        if (!upRes.ok) return { ok: false, class: "transient", message: `upload_url_${upRes.status}` };
        // 3) Complete + share it into the thread.
        const compRes = await fetch(`${config.apiUrl}files.completeUploadExternal`, {
          method: "POST",
          headers: { authorization: auth, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            files: [{ id: g.file_id, title: title ?? filename }],
            channel_id: channel,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            ...(initialComment ? { initial_comment: initialComment } : {}),
          }),
        });
        if (compRes.status === 429) return rateLimited(compRes);
        const c = (await compRes.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        return c.ok ? { ok: true } : classify(c.error ?? String(compRes.status));
      } catch (err) {
        return { ok: false, class: "transient", message: (err as Error).message };
      }
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
