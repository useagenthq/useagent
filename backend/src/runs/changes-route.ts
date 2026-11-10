import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { sseResponse } from "../util/sse";
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
    // `retry` has the browser reconnect quickly after a drop; the subscription
    // is the only thing to undo when it leaves.
    return sseResponse({ signal: c.req.raw.signal, retryMs: 1500 }, (stream) =>
      subscribeOrg(orgId, (change) => {
        const clientChange = clientOrgChangeForUser(change, userId);
        if (clientChange) stream.sendEvent("change", clientChange);
      }),
    );
  });
}
