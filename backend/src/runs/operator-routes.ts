import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../http";
import type { RunCreateBody } from "./routes";

/**
 * Loopback operator bridge for cross-process run dispatch.
 *
 * WHY THIS EXISTS: run execution is process-local by design (one backend per
 * database), and the codex subscription relay rendezvous is too - the relay
 * capability is minted in the process that runs the engine, and the sandbox
 * dials the PUBLIC relay URL, which lands on the systemd backend. An operator
 * tool (the release-lane parity canary) that claims runs in its OWN process
 * therefore strands codex dials on tokens the backend never minted: the
 * 2026-08-19 release-gate incident, where every codex parity case failed with
 * "no first activity" while direct API runs passed. This bridge lets such a
 * tool insert a run with acceptRunCommand and then ask THIS process to pump
 * the thread, so execution and the relay share one process.
 *
 * AUTH: the host-local operator secret as a bearer token, compared in constant
 * time. Proxied requests are rejected outright - Caddy and the Next rewrite
 * always append X-Forwarded-For, so only direct loopback callers (who already
 * hold the host's environment) can present the header-free shape.
 */

interface OperatorOps {
  readonly pump: (threadId: string) => Promise<string | null>;
  readonly cancel: (runId: string, reason: string) => boolean;
  /** Approve one pending gateway approval request AS the target run's owner
   *  (the parity canary acting as the human in the approval-lane journey). */
  readonly approveGatewayRequest: (
    requestId: string,
  ) => Promise<{ approved: boolean; error?: string }>;
  readonly admitReleaseParity: (
    c: Context<AppEnv>,
    body: RunCreateBody,
  ) => Promise<Response>;
}

function bearer(header: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return match?.[1]?.trim() ?? "";
}

function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function createOperatorRoutes(ops: OperatorOps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.use("*", async (c, next) => {
    if (c.req.header("x-forwarded-for")) return c.json({ error: "not_found" }, 404);
    const secret = process.env.BETTER_AUTH_SECRET?.trim() ?? "";
    if (!secret || !secretMatches(bearer(c.req.header("authorization")), secret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  routes.post("/pump-thread", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { threadId?: unknown } | null;
    const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
    if (!threadId) return c.json({ error: "threadId_required" }, 400);
    return c.json({ dispatched: await ops.pump(threadId) });
  });

  // legacy alias: pre-rename ops tooling posts to /admit-release-eval
  routes.post("/admit-release-eval", async (c) => {
    const payload = (await c.req.json().catch(() => null)) as { run?: unknown } | null;
    if (!payload || typeof payload.run !== "object" || payload.run === null) {
      return c.json({ error: "run object is required" }, 400);
    }
    return ops.admitReleaseParity(c, payload.run as RunCreateBody);
  });
  routes.post("/admit-release-eval", async (c) => {
    const payload = (await c.req.json().catch(() => null)) as {
      orgId?: unknown;
      userId?: unknown;
      run?: unknown;
    } | null;
    const orgId = typeof payload?.orgId === "string" ? payload.orgId.trim() : "";
    const userId = typeof payload?.userId === "string" ? payload.userId.trim() : "";
    if (
      !orgId ||
      !userId ||
      !payload?.run ||
      typeof payload.run !== "object" ||
      Array.isArray(payload.run)
    ) {
      return c.json({ error: "orgId_userId_run_required" }, 400);
    }
    c.set("orgId", orgId);
    c.set("userId", userId);
    return ops.admitReleaseParity(c, payload.run as RunCreateBody);
  });

  routes.post("/approve-gateway-request", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { requestId?: unknown } | null;
    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
    if (!requestId) return c.json({ error: "requestId_required" }, 400);
    return c.json(await ops.approveGatewayRequest(requestId));
  });

  routes.post("/signal-cancel", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      runId?: unknown;
      reason?: unknown;
    } | null;
    const runId = typeof body?.runId === "string" ? body.runId.trim() : "";
    if (!runId) return c.json({ error: "runId_required" }, 400);
    const reason = typeof body?.reason === "string" && body.reason.trim()
      ? body.reason.trim()
      : "Cancelled by operator";
    return c.json({ signalled: ops.cancel(runId, reason) });
  });

  return routes;
}
