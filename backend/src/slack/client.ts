/**
 * Minimal Slack Web API client — only the two calls v1 needs: a 👀 ack reaction
 * on receipt and a threaded `chat.postMessage` on run completion. QM's full
 * delivery stack (retries, verification, chunking, mrkdwn, blocks) is DEFERRED.
 *
 * A module-level override (`setSlackClientForTest`) lets unit tests record calls
 * instead of hitting the network — the event/watcher code always resolves the
 * client through `resolveSlackClient()`, never `fetch` directly.
 */
import type { SlackConfig } from "../env";

export interface SlackClient {
  /** Post a message; `threadTs` keeps every reply inside the Slack thread. */
  postMessage(args: { channel: string; text: string; threadTs?: string }): Promise<void>;
  /** Add a reaction emoji (name without colons) to a specific message. */
  addReaction(args: { channel: string; timestamp: string; name: string }): Promise<void>;
  /**
   * Slack AI-Apps assistant status — the shimmering "Starting up…" line under the
   * bot's reply. Empty `status` clears it. Only works in assistant containers
   * (the app needs the Agents/AI-Apps feature + `assistant:write`); elsewhere
   * Slack returns an error which the client swallows, so callers can fire this
   * unconditionally and non-assistant contexts fall back to the ack/post path.
   */
  setAssistantStatus(args: { channel: string; threadTs: string; status: string }): Promise<void>;
}

/** Real client: thin `fetch` wrapper over the Slack Web API. Errors are logged
 * and swallowed — a Slack outage must never fail (or retry-storm) a run. */
export function httpSlackClient(config: SlackConfig): SlackClient {
  async function call(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(`${config.apiUrl}${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(params),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!data.ok) console.error(`[slack] ${method} failed: ${data.error ?? res.status}`);
    } catch (err) {
      console.error(`[slack] ${method} error:`, (err as Error).message);
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
    setAssistantStatus: ({ channel, threadTs, status }) =>
      call("assistant.threads.setStatus", {
        channel_id: channel,
        thread_ts: threadTs,
        status,
      }),
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
