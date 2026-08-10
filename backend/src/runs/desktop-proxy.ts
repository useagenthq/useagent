import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { getRunForOrg } from "./repo";
import {
  buildForwardHeaders,
  buildProxyResponse,
  invalidatePreviewEndpoint,
  resolvePreviewEndpoint,
  resolvePreviewSandbox,
  type PreviewEndpoint,
} from "./preview-proxy";
import { ensureSandboxDesktopView } from "../engines/desktop";

// ---------------------------------------------------------------------------
// DESKTOP PROXY — same-origin bridge to the noVNC GUI running INSIDE a thread's
// sandbox (multi-repo "watch the agent's screen"). The skynet-agent snapshot
// ships Xvfb :1 + XFCE + x11vnc :5900 (no password) + noVNC/websockify on :6080.
//
//   browser (iframe) → GET /api/desktop-proxy/<threadId>/vnc.html?…&path=<self>/websockify
//                     → HTTP proxy: resolve the thread's :6080 preview endpoint,
//                       inject x-daytona-preview-token, forward noVNC's static
//                       app (html/js/css) verbatim.
//   noVNC canvas WS   → ws  /api/desktop-proxy/<threadId>/websockify
//                     → WS bridge (below): open an upstream WS to the sandbox's
//                       websockify with the preview token as a header — browsers
//                       can't set that header, and noVNC rebuilds its socket URL
//                       from window.location (dropping any signed-URL query), so
//                       a tokenised preview URL alone can't authenticate the
//                       socket. The proxy is what makes it work without leaking
//                       the Daytona token to the browser. RFB frames pipe both
//                       ways as binary.
//
// Shares one Bun WebSocket handler (`websocket` from hono/bun, registered in
// index.ts) with the interactive terminal — the same dispatcher routes per
// connection by the events stashed at upgrade.
// ---------------------------------------------------------------------------

const DESKTOP_PORT = 6080;
const desktopRepairs = new Map<string, Promise<void>>();

/** Old retained sandboxes may predate desktop provisioning, and a stopped box
 * may wake without its process session. Repair exactly once per thread while
 * concurrent iframe/static/WebSocket requests wait on the same promise. */
async function ensureDesktopPreview(threadId: string): Promise<void> {
  const existing = desktopRepairs.get(threadId);
  if (existing) return existing;

  const repair = (async () => {
    const sandbox = await resolvePreviewSandbox(threadId);
    const desktop = await ensureSandboxDesktopView(sandbox, AbortSignal.timeout(120_000));
    if (!desktop.available) {
      throw new Error(desktop.reason ?? "desktop service unavailable");
    }
  })().finally(() => desktopRepairs.delete(threadId));
  desktopRepairs.set(threadId, repair);
  return repair;
}

export const desktopProxyRoutes = new Hono<AppEnv>();
desktopProxyRoutes.use("*", orgScope);

// ── WebSocket: browser noVNC ⇄ (this bridge) ⇄ sandbox websockify ───────────
// Registered BEFORE the HTTP catch-all so a genuine upgrade is handled here; a
// plain GET to the same path falls through (upgradeWebSocket calls next()).
desktopProxyRoutes.get(
  "/:threadId/websockify",
  upgradeWebSocket((c) => {
    // Capture params NOW — context reads inside async ws callbacks are unreliable.
    const threadId = c.req.param("threadId") ?? "";
    const orgId = c.get("orgId");
    const search = new URL(c.req.url).search;
    let upstream: WebSocket | null = null;
    let closed = false;

    return {
      onOpen: (_evt, ws) => {
        void (async () => {
          try {
            // Org gate: threadId IS its root run's id (see live-proxy).
            if (!(await getRunForOrg(orgId, threadId))) throw new Error("thread not found");

            await ensureDesktopPreview(threadId);
            const ep = await resolvePreviewEndpoint(threadId, DESKTOP_PORT);
            const wsUrl = `${ep.baseUrl.replace(/^http/, "ws")}/websockify${search}`;
            // Bun's WebSocket client takes custom headers (browsers can't) — this
            // is how the Daytona preview token rides the upstream socket.
            const sock = new WebSocket(wsUrl, {
              headers: { "x-daytona-preview-token": ep.token },
              protocols: ["binary"],
            });
            sock.binaryType = "arraybuffer";
            upstream = sock;
            sock.onmessage = (e) => {
              if (closed) return;
              try {
                ws.send(e.data as ArrayBuffer | string);
              } catch {
                /* browser socket already gone */
              }
            };
            const bye = () => {
              try {
                ws.close();
              } catch {
                /* already closed */
              }
            };
            sock.onclose = bye;
            sock.onerror = bye;
          } catch {
            // Stale endpoint (sandbox rotated) or no sandbox — drop the cache so
            // the next attempt re-resolves and wakes the box, then close.
            invalidatePreviewEndpoint(threadId, DESKTOP_PORT);
            try {
              ws.close();
            } catch {
              /* already closed */
            }
          }
        })();
      },

      onMessage: (evt) => {
        const sock = upstream;
        if (!sock || sock.readyState !== WebSocket.OPEN) return;
        try {
          // evt.data is a string (text frame) or ArrayBuffer (binary RFB frame).
          sock.send(evt.data as string | ArrayBuffer);
        } catch {
          /* upstream gone */
        }
      },

      onClose: () => {
        closed = true;
        const sock = upstream;
        upstream = null;
        if (sock) {
          try {
            sock.close();
          } catch {
            /* already closed */
          }
        }
      },
    };
  }),
);

// ── HTTP: noVNC static app (vnc.html + js/css/img) ──────────────────────────
desktopProxyRoutes.all("/:threadId/*", async (c) => {
  const threadId = c.req.param("threadId") ?? "";
  const orgId = c.get("orgId");

  if (!(await getRunForOrg(orgId, threadId))) {
    return c.json({ error: "thread not found" }, 404);
  }

  const url = new URL(c.req.url);
  const prefix = `/api/desktop-proxy/${threadId}`;
  const subpath = url.pathname.slice(prefix.length) || "/";

  // The pane probes vnc.html before mounting its iframe. Treat that one HTML
  // request as the lifecycle boundary: wake/repair the Desktop there, without
  // repeating Daytona health checks for every noVNC JS/CSS asset.
  if (subpath === "/vnc.html") {
    try {
      await ensureDesktopPreview(threadId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "no-sandbox") {
        return c.json({ error: "no live sandbox for this conversation yet - send a message first" }, 409);
      }
      return c.json({ error: `desktop proxy failed: ${message}` }, 502);
    }
  }

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
    let ep = await resolvePreviewEndpoint(threadId, DESKTOP_PORT);
    let upstream: Response;
    try {
      upstream = await forward(ep);
    } catch {
      upstream = new Response(null, { status: 502 });
    }
    // A stale preview link (sandbox stopped/rotated since we cached it) surfaces
    // as a transport failure or a 5xx — re-resolve once (wakes the box) and retry.
    if (upstream.status === 502 || upstream.status === 503) {
      await ensureDesktopPreview(threadId);
      invalidatePreviewEndpoint(threadId, DESKTOP_PORT);
      ep = await resolvePreviewEndpoint(threadId, DESKTOP_PORT, true);
      upstream = await forward(ep);
    }
    return buildProxyResponse(upstream);
  } catch (err) {
    invalidatePreviewEndpoint(threadId, DESKTOP_PORT);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "no-sandbox") {
      return c.json(
        { error: "no live sandbox for this conversation yet - send a message first" },
        409,
      );
    }
    return c.json({ error: `desktop proxy failed: ${msg}` }, 502);
  }
});
