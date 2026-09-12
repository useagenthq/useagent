import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { clientOrgChangeForUser, subscribeOrg } from "./org-signals";

/** GET /api/runs/changes - the tenant-scoped invalidation stream. */
export function registerRunChangesRoute(routes: Hono<AppEnv>): void {
// One lightweight, tenant-scoped invalidation stream for ambient product
// surfaces (Workspace, Runs, Recents, Artifacts). The database remains the
// source of truth: events carry IDs only and tell clients which snapshot to
// refresh. The active conversation keeps its richer thread-events stream.
  routes.get("/changes", (c) => {
    const orgId = c.get("orgId");
    const userId = c.get("userId");
    const encoder = new TextEncoder();
    const signal = c.req.raw.signal;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const send = (frame: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            cleanup();
          }
        };
        const unsubscribe = subscribeOrg(orgId, (change) => {
          const clientChange = clientOrgChangeForUser(change, userId);
          if (!clientChange) return;
          send(`event: change\ndata: ${JSON.stringify(clientChange)}\n\n`);
        });
        const heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
        heartbeat.unref?.();

        function cleanup(): void {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          signal.removeEventListener("abort", cleanup);
          try {
            controller.close();
          } catch {
            // The browser may already have closed the stream.
          }
        }

        send(": open\nretry: 1500\n\n");
        if (signal.aborted) cleanup();
        else signal.addEventListener("abort", cleanup);
      },
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
