import { Daytona } from "@daytona/sdk";
import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { getOpencodeThreadSandboxId } from "../engines/opencode-server";
import { getThreadSandbox, getRunForOrg } from "./repo";

// ---------------------------------------------------------------------------
// LIVE PROXY — same-origin path bridge to a thread's opencode server, so the
// embedded opencode web app (frontend/public/opencode-app, the "Live" tab) can
// talk to its sandbox without CORS or a leaked Daytona preview token.
//
//   browser (iframe) → /api/live-proxy/<threadId>/<opencodePath>
//                     → this route: resolve the thread's sandbox, get its
//                       :4096 preview link, inject x-daytona-preview-token,
//                       forward verbatim, STREAM the response back (incl. the
//                       SSE /api/event channel — no buffering).
//
// The embed points its opencode client at a sentinel origin and rewrites those
// fetches onto `/api/live-proxy/<threadId>` (see packages/app/src/entry.tsx in
// the vendored build), so the full opencode path (`/api/event`, `/api/config`,
// `/api/session/…`) arrives here as the suffix and is passed straight through.
// ---------------------------------------------------------------------------

const SERVE_PORT = 4096;

interface Endpoint {
  sandboxId: string;
  baseUrl: string;
  token: string;
}

/** Per-thread preview endpoint cache. Cheap to rebuild (a backend restart just
 *  re-resolves); invalidated + re-resolved on the first upstream failure so a
 *  stopped/rotated sandbox self-heals (getPreviewLink after start() wakes it). */
const endpoints = new Map<string, Endpoint>();

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

async function resolveEndpoint(threadId: string, force = false): Promise<Endpoint> {
  if (!force) {
    const cached = endpoints.get(threadId);
    if (cached) return cached;
  }
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) throw new Error("live proxy needs DAYTONA_API_KEY in the backend env");

  const sandboxId =
    getOpencodeThreadSandboxId(threadId) ?? (await getThreadSandbox(threadId));
  if (!sandboxId) throw new Error("no-sandbox");

  const daytona = new Daytona({ apiKey, target: process.env.DAYTONA_TARGET ?? "us" });
  const sandbox = await daytona.get(sandboxId);
  const state = (sandbox as { state?: string }).state;
  if (state === "stopped" || state === "paused" || state === "archived") {
    await sandbox.start();
  }
  const link = await sandbox.getPreviewLink(SERVE_PORT);
  const ep: Endpoint = {
    sandboxId,
    baseUrl: link.url.replace(/\/+$/, ""),
    token: link.token ?? "",
  };
  endpoints.set(threadId, ep);
  return ep;
}

function buildForwardHeaders(src: Headers, token: string): Headers {
  const headers = new Headers();
  src.forEach((value, key) => {
    if (!STRIP_REQUEST.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("x-daytona-preview-token", token);
  return headers;
}

function buildResponse(upstream: Response): Response {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE.has(key.toLowerCase())) headers.set(key, value);
  });
  // SSE hygiene — mirror runs/routes.ts: stop any proxy buffering/transforming
  // the opencode /api/event stream so token deltas arrive live in the embed.
  if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
    headers.set("Cache-Control", "no-cache, no-transform");
    headers.set("X-Accel-Buffering", "no");
    headers.set("Connection", "keep-alive");
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export const liveProxyRoutes = new Hono<AppEnv>();
liveProxyRoutes.use("*", orgScope);

liveProxyRoutes.all("/:threadId/*", async (c) => {
  const threadId = c.req.param("threadId");
  const orgId = c.get("orgId");

  // Org gate: a thread id IS its root run's id, so this both authorizes the org
  // and 404s a cross-org / unknown thread (indistinguishable, as elsewhere).
  if (!(await getRunForOrg(orgId, threadId))) {
    return c.json({ error: "thread not found" }, 404);
  }

  const url = new URL(c.req.url);
  const prefix = `/api/live-proxy/${threadId}`;
  const subpath = url.pathname.slice(prefix.length) || "/";

  const method = c.req.method;
  const body =
    method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();

  const forward = async (ep: Endpoint): Promise<Response> =>
    fetch(`${ep.baseUrl}${subpath}${url.search}`, {
      method,
      headers: buildForwardHeaders(c.req.raw.headers, ep.token),
      body,
      redirect: "manual",
      signal: c.req.raw.signal,
    });

  try {
    let ep = await resolveEndpoint(threadId);
    let upstream: Response;
    try {
      upstream = await forward(ep);
    } catch {
      upstream = new Response(null, { status: 502 });
    }
    // A stale preview link (sandbox stopped/rotated since we cached it) surfaces
    // as a transport failure or a 5xx from Daytona's proxy — re-resolve once
    // (which wakes the box) and retry before giving up.
    if (upstream.status === 502 || upstream.status === 503) {
      ep = await resolveEndpoint(threadId, true);
      upstream = await forward(ep);
    }
    return buildResponse(upstream);
  } catch (err) {
    endpoints.delete(threadId);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "no-sandbox") {
      return c.json(
        { error: "no live sandbox for this conversation yet — send a message first" },
        409,
      );
    }
    return c.json({ error: `live proxy failed: ${msg}` }, 502);
  }
});
