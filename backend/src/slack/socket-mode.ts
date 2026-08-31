/**
 * Slack Socket Mode transport - an OUTBOUND WebSocket ingress for the same
 * event pipeline as the HTTP receiver (routes.ts). Config-gated on
 * SLACK_APP_TOKEN (xapp-...): when present, we call apps.connections.open,
 * connect to the returned wss URL, persist `events_api` payloads into the same
 * durable inbox as HTTP, then ack by envelope_id only after the commit.
 * No public URL or signing verification is involved - Slack authenticates the
 * connection via the app-level token, and events arrive only on sockets we
 * opened.
 *
 * Reconnect discipline: Slack refreshes sockets (~every few minutes) with a
 * `disconnect` frame; any close/error schedules a fresh connections.open after
 * a short backoff. One connection at a time per process. NOTE: Slack
 * load-balances events across ALL open Socket Mode connections for the app -
 * if another service also holds a socket for this app, each receives a subset.
 */
import { slackEventIsEarlyNoop, type SlackEnvelope } from "./events";
import { classifySlackInboxEvent, persistSlackInboxEvent } from "./inbox";

const RECONNECT_DELAY_MS = 3_000;

interface SocketEnvelope {
  type?: string; // "hello" | "events_api" | "disconnect" | ...
  envelope_id?: string;
  payload?: SlackEnvelope;
  reason?: string;
}

let socket: WebSocket | null = null;
let stopped = false;

function appToken(): string | null {
  return process.env.SLACK_APP_TOKEN?.trim() || null;
}

async function openConnectionUrl(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json()) as { ok?: boolean; url?: string; error?: string };
    if (!j.ok || !j.url) {
      console.error(`[slack:socket] connections.open failed: ${j.error ?? res.status}`);
      return null;
    }
    return j.url;
  } catch (err) {
    console.error("[slack:socket] connections.open error:", err);
    return null;
  }
}

function scheduleReconnect(token: string): void {
  if (stopped) return;
  setTimeout(() => void connect(token), RECONNECT_DELAY_MS).unref?.();
}

/**
 * Dispatch one decoded Socket Mode frame. Authenticated `events_api` payloads
 * are acked only after durable inbox persistence. A persistence failure leaves
 * the envelope unacked so Slack retries it on this or another socket.
 */
export function dispatchSocketFrame(
  raw: string,
  ack: (envelopeId: string) => void,
  onDisconnect: () => void,
): Promise<void> {
  let env: SocketEnvelope;
  try {
    env = JSON.parse(raw) as SocketEnvelope;
  } catch {
    return Promise.resolve();
  }
  if (env.type === "hello") {
    if (env.envelope_id) ack(env.envelope_id);
    return Promise.resolve();
  }
  if (env.type === "disconnect") {
    if (env.envelope_id) ack(env.envelope_id);
    // Slack asks us to refresh; closing the socket triggers the reconnect.
    onDisconnect();
    return Promise.resolve();
  }
  if (env.type === "events_api" && env.payload) {
    if (slackEventIsEarlyNoop(env.payload)) {
      if (env.envelope_id) ack(env.envelope_id);
      return Promise.resolve();
    }
    return classifySlackInboxEvent(env.payload)
      .then(async (decision) => {
        if (decision !== "drop") await persistSlackInboxEvent(env.payload!, decision);
        if (env.envelope_id) ack(env.envelope_id);
      })
      .catch((error) => {
        console.error("[slack:socket] inbox persistence failed:", (error as Error).message);
      });
  }
  if (env.envelope_id) ack(env.envelope_id);
  return Promise.resolve();
}

async function connect(token: string): Promise<void> {
  if (stopped) return;
  const url = await openConnectionUrl(token);
  if (!url) return scheduleReconnect(token);

  const ws = new WebSocket(url);
  socket = ws;

  ws.onopen = () => console.log("[slack:socket] connected (socket mode)");
  ws.onmessage = (msg) => {
    void dispatchSocketFrame(
      String(msg.data),
      (id) => ws.send(JSON.stringify({ envelope_id: id })),
      () => {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      },
    );
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    scheduleReconnect(token);
  };
  ws.onerror = (err) => {
    console.error("[slack:socket] ws error:", err);
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  };
}

/** True under the test runner. `bun test` sets NODE_ENV=test, so the app boot
 *  that tests trigger (importing src/index.ts) inherits it. */
function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test";
}

/** Start the Socket Mode ingress. No-op unless SLACK_APP_TOKEN is set (the
 *  HTTP events route stays mounted either way - both lanes share the durable
 *  inbox, so double delivery collapses before processing).
 *
 *  HARD no-op under test: a test-booted server carrying the real SLACK_APP_TOKEN
 *  would otherwise open a live WebSocket to the workspace and STEAL real events
 *  mid-suite (Slack load-balances events across all open sockets). The guard
 *  runs before we ever touch the token or the network. */
export function startSlackSocketMode(): void {
  if (isTestEnv()) return;
  const token = appToken();
  if (!token) return;
  stopped = false;
  void connect(token);
}

/** Test/shutdown hook. */
export function stopSlackSocketMode(): void {
  stopped = true;
  try {
    socket?.close();
  } catch {
    /* already closed */
  }
  socket = null;
}
