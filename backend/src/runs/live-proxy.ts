import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { getRunForOrg } from "./repo";
import {
  buildForwardHeaders,
  buildProxyResponse,
  invalidatePreviewEndpoint,
  resolvePreviewEndpoint,
  type PreviewEndpoint,
} from "./preview-proxy";

// ---------------------------------------------------------------------------
// LIVE PROXY — same-origin path bridge to a thread's opencode server, so the
// embedded opencode web app (frontend/public/opencode-app, the "Live" tab) can
// talk to its sandbox without CORS or a leaked Daytona preview token.
//
//   browser (iframe) → /api/live-proxy/<threadId>/<opencodePath>
//                     → this route: resolve the thread's :4096 preview endpoint
//                       (see preview-proxy.ts), inject x-daytona-preview-token,
//                       forward verbatim, STREAM the response back (incl. the
//                       SSE /api/event channel — no buffering).
//
// The embed points its opencode client at a sentinel origin and rewrites those
// fetches onto `/api/live-proxy/<threadId>` (see packages/app/src/entry.tsx in
// the vendored build), so the full opencode path (`/api/event`, `/api/config`,
// `/api/session/…`) arrives here as the suffix and is passed straight through.
// ---------------------------------------------------------------------------

const SERVE_PORT = 4096;

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

  const forward = async (ep: PreviewEndpoint): Promise<Response> =>
    fetch(`${ep.baseUrl}${subpath}${url.search}`, {
      method,
      headers: buildForwardHeaders(c.req.raw.headers, ep.token),
      body,
      redirect: "manual",
      signal: c.req.raw.signal,
    });

  try {
    let ep = await resolvePreviewEndpoint(threadId, SERVE_PORT);
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
      ep = await resolvePreviewEndpoint(threadId, SERVE_PORT, true);
      upstream = await forward(ep);
    }
    return buildProxyResponse(upstream);
  } catch (err) {
    invalidatePreviewEndpoint(threadId, SERVE_PORT);
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
