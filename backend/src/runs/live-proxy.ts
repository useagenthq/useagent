import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { cacheCommandCatalog, defaultSnapshot } from "./command-catalog";
import { getRunForOrg } from "./repo";
import {
  buildForwardHeaders,
  buildProxyResponse,
  invalidatePreviewEndpoint,
  resolvePreviewEndpoint,
  type PreviewEndpoint,
} from "./preview-proxy";
import { OPENCODE_ALLOWED_MODELS } from "./model-policy";

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

// ── Model allowlist ─────────────────────────────────────────────────────────
// The embed's model picker fetches GET /api/model (and /api/provider) through
// this proxy. opencode's own catalog offers everything it can reach — models.dev
// + the OpenCode Zen gateway + every free OpenRouter tier (~377 models). opencode
// v2 (the resident server) has NO server-side provider allowlist: its catalog
// (packages/core catalog.ts) filters only by a per-model `disabled` flag, and the
// v1→v2 config migration drops `enabled_providers`/`whitelist` — so a staged
// opencode.json can't trim the picker (verified: /config loads it, /api/model
// ignores it). The proxy is the one place the embed reaches the sandbox, so we
// trim the catalog to the deployment's curated set HERE. Prompt POSTs go DIRECT to the
// sandbox (not through this proxy) and still resolve every id, so the backend's
// own runs are unaffected.
const ALLOWED_MODELS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries(OPENCODE_ALLOWED_MODELS).map(([provider, models]) => [
    provider,
    new Set<string>(models),
  ]),
);
const ALLOWED_PROVIDERS = new Set(Object.keys(ALLOWED_MODELS));

/** Opportunistically cache the snapshot's slash-command catalog. `/command` is a
 *  tiny JSON body identical across a snapshot's sandboxes, so tap it once (from
 *  any thread) into the snapshot-keyed cache the New Task composer reads before a
 *  sandbox exists. Best-effort: buffer the body, cache fire-and-forget, and
 *  return an equivalent Response so the caller's normal proxy path is unchanged.
 *  Any other path (or a non-200) streams through untouched. */
async function tapCommandCatalog(subpath: string, upstream: Response): Promise<Response> {
  if (subpath !== "/command" || upstream.status !== 200) return upstream;
  const text = await upstream.text();
  void cacheCommandCatalog(defaultSnapshot(), text).catch(() => {});
  return new Response(text, { status: upstream.status, headers: upstream.headers });
}

/** Trim the picker's catalog responses to the deployment's allowed providers + models.
 *  `/api/model` → `{ location, data:[{id, providerID, …}] }`; `/api/provider` →
 *  `{ location, data:[{id, …}] }`. Non-catalog paths pass straight through. The
 *  proxy already strips `accept-encoding` upstream, so the body is plain JSON. */
async function filterCatalogResponse(subpath: string, upstream: Response): Promise<Response> {
  const isModel = subpath === "/api/model";
  const isProvider = subpath === "/api/provider";
  if ((!isModel && !isProvider) || upstream.status !== 200) return buildProxyResponse(upstream);

  const text = await upstream.text();
  const rewrap = (bodyText: string) =>
    buildProxyResponse(new Response(bodyText, { status: upstream.status, headers: upstream.headers }));

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rewrap(text); // not the JSON we expected — forward verbatim
  }
  const list = Array.isArray(body)
    ? body
    : ((body as { data?: unknown })?.data as unknown[] | undefined);
  if (!Array.isArray(list)) return rewrap(text);

  const filtered = list.filter((item) => {
    const rec = item as { id?: unknown; providerID?: unknown };
    return isModel
      ? ALLOWED_MODELS[String(rec.providerID)]?.has(String(rec.id)) ?? false
      : ALLOWED_PROVIDERS.has(String(rec.id));
  });
  const out = Array.isArray(body) ? filtered : { ...(body as object), data: filtered };
  return rewrap(JSON.stringify(out));
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
    // Tap /command into the snapshot-level catalog cache (best-effort), then
    // trim the model/provider catalog endpoints to the deployment allowlist; everything
    // else (incl. the /api/event SSE) streams through untouched.
    upstream = await tapCommandCatalog(subpath, upstream);
    return filterCatalogResponse(subpath, upstream);
  } catch (err) {
    invalidatePreviewEndpoint(threadId, SERVE_PORT);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "no-sandbox") {
      return c.json(
        { error: "no live sandbox for this conversation yet - send a message first" },
        409,
      );
    }
    return c.json({ error: `live proxy failed: ${msg}` }, 502);
  }
});
