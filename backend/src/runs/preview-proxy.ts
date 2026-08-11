import { daytonaProvider, type SandboxHandle } from "../sandboxes/provider";
import {
  forgetLiveThreadSandbox,
  getLiveThreadSandbox,
  rememberLiveThreadSandbox,
} from "../engines/sandbox-runtime";
import { getThreadSandbox } from "./repo";

// ---------------------------------------------------------------------------
// PREVIEW PROXY — shared machinery for the same-origin bridges that expose a
// service running INSIDE a thread's Daytona sandbox to the browser without CORS
// or a leaked preview token: the opencode server on :4096 (the "Live" tab, see
// live-proxy.ts) and the noVNC desktop on :6080 (the "Desktop" tab, see
// desktop-proxy.ts). It resolves the thread's sandbox, wakes it if stopped, and
// caches the per-port preview endpoint (url + token); the caller forwards
// requests with the token injected server-side.
// ---------------------------------------------------------------------------

export interface PreviewEndpoint {
  sandboxId: string;
  baseUrl: string;
  token: string;
}

/** Per (thread, port) preview endpoint cache. A thread now exposes several ports
 *  (4096 opencode, 6080 desktop), so the key carries the port. Cheap to rebuild
 *  (a backend restart re-resolves); invalidated + re-resolved on the first
 *  upstream failure so a stopped/rotated sandbox self-heals (getPreviewLink after
 *  start() wakes it). */
const endpoints = new Map<string, PreviewEndpoint>();

/** Hop-by-hop / connection headers that must not be forwarded either way. */
const STRIP_REQUEST = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "cookie",
  "x-daytona-preview-token",
]);
const STRIP_RESPONSE = new Set([
  "connection",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

export async function resolvePreviewEndpoint(
  threadId: string,
  port: number,
  force = false,
): Promise<PreviewEndpoint> {
  const key = `${threadId}:${port}`;
  if (!force) {
    const cached = endpoints.get(key);
    if (cached) return cached;
  }
  let sandbox = await resolvePreviewSandbox(threadId);
  let link: Awaited<ReturnType<SandboxHandle["getPreviewLink"]>>;
  try {
    link = await sandbox.getPreviewLink(port);
  } catch {
    // A process-local SDK object can outlive a Daytona-side rotation. Evict it
    // and retry once through the durable mapping instead of pinning every
    // subsequent preview request to a dead object.
    forgetLiveThreadSandbox(threadId, sandbox.id);
    sandbox = await resolvePreviewSandbox(threadId);
    link = await sandbox.getPreviewLink(port);
  }
  const ep: PreviewEndpoint = {
    sandboxId: sandbox.id,
    baseUrl: link.url.replace(/\/+$/, ""),
    token: link.token ?? "",
  };
  endpoints.set(key, ep);
  return ep;
}

/** Resolve and wake the durable Daytona sandbox behind a thread. Kept beside
 * preview-link resolution so terminal/desktop proxies do not duplicate sandbox
 * identity or lifecycle rules. */
export async function resolvePreviewSandbox(threadId: string): Promise<SandboxHandle> {
  const cached = getLiveThreadSandbox(threadId);
  if (cached) {
    const state = (cached as { state?: string }).state;
    if (state === "stopped" || state === "paused" || state === "archived") {
      try {
        await cached.start();
        return cached;
      } catch {
        forgetLiveThreadSandbox(threadId, cached.id);
      }
    } else if (state === undefined || state === "started") {
      return cached;
    } else {
      forgetLiveThreadSandbox(threadId, cached.id);
    }
  }

  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) throw new Error("preview proxy needs DAYTONA_API_KEY in the backend env");

  const sandboxId = await getThreadSandbox(threadId);
  if (!sandboxId) throw new Error("no-sandbox");

  const daytona = daytonaProvider(apiKey);
  const sandbox = await daytona.get(sandboxId);
  const state = (sandbox as { state?: string }).state;
  if (state === "stopped" || state === "paused" || state === "archived") {
    await sandbox.start();
  }
  rememberLiveThreadSandbox(threadId, sandbox);
  return sandbox;
}

/** Drop a cached endpoint so the next resolve re-fetches (and wakes the box). */
export function invalidatePreviewEndpoint(threadId: string, port: number): void {
  endpoints.delete(`${threadId}:${port}`);
}

export function buildForwardHeaders(src: Headers, token: string): Headers {
  const headers = new Headers();
  src.forEach((value, key) => {
    if (!STRIP_REQUEST.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("x-daytona-preview-token", token);
  return headers;
}

export function buildProxyResponse(upstream: Response): Response {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE.has(key.toLowerCase())) headers.set(key, value);
  });
  // SSE hygiene — mirror runs/routes.ts: stop any proxy buffering/transforming
  // an event-stream so token deltas arrive live in the embed.
  if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
    headers.set("Cache-Control", "no-cache, no-transform");
    headers.set("X-Accel-Buffering", "no");
    headers.set("Connection", "keep-alive");
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
