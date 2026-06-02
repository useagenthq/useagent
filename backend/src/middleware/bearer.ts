import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../http";
import {
  API_KEY_PREFIX,
  findActiveApiKeyByHash,
  hashApiKey,
  touchApiKeyLastUsed,
} from "../api-keys/store";

// ---------------------------------------------------------------------------
// Bearer auth lane for org API keys. A request carrying `Authorization: Bearer
// uak_...` is authenticated against a stored SHA-256 hash and, on success, runs
// with the SAME context keys orgScope sets (orgId, userId) PLUS a
// `bearerAuthenticated` marker. Everything is fail-closed:
//
//   - Only tokens with the `uak_` scheme are claimed. Any other Authorization
//     value is ignored here and left to the session lane (so cookie auth and the
//     self-authenticating internal bearer routes keep working unchanged).
//   - An unknown or revoked key -> 401. It NEVER falls through to the session /
//     dev-org lane (a bad key must not silently become anonymous access).
//   - A DENY-BY-DEFAULT route allowlist: a valid key may reach ONLY the explicit
//     (method, path) set below. Anything else -> 401. Management of keys, secrets,
//     settings, integrations, and memory admin are all outside the allowlist and
//     so are unreachable by any key.
// ---------------------------------------------------------------------------

/** Pull a `uak_`-scheme token out of an Authorization header, else null. The
 *  scheme word is case-insensitive (per RFC 7235); the `uak_` prefix is what
 *  claims the token for this lane, so non-`uak_` bearers pass through untouched. */
export function extractBearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return null;
  const token = match[1]!.trim();
  return token.startsWith(API_KEY_PREFIX) ? token : null;
}

/**
 * The v1 bearer route allowlist - DENY BY DEFAULT. A key may:
 *   - GET  /api/config          read the client/engine manifest
 *   - POST /api/runs            dispatch a new run (EXACT: no sub-actions)
 *   - GET  /api/runs*           read runs: list, one run/thread, timings,
 *                               uploads, and the events + thread-events SSE
 *   - GET  /api/artifacts*      read durable artifacts (writes excluded by GET)
 * Everything else returns false and the caller answers 401. Pure + exported so
 * the fail-closed default is unit-testable without a live request.
 */
export function isBearerAllowedPath(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" && path === "/api/config") return true;
  // Dispatch a run. EXACT match - cancel/reply/sandbox-release sub-routes are
  // POST/DELETE under /api/runs/:id and are intentionally NOT reachable.
  if (m === "POST" && path === "/api/runs") return true;
  if (m !== "GET") return false;

  // Exact read-only run routes. Do not broaden this to `/api/runs/*`: the
  // interactive terminal is a GET WebSocket mounted at `/api/runs/:id/terminal`.
  if (path === "/api/runs" || path === "/api/runs/changes") return true;
  if (/^\/api\/runs\/[^/]+(?:\/(?:uploads|timings|events|thread-events))?$/.test(path)) {
    return true;
  }

  // Exact read-only artifact routes. Keep control/write routes out by default.
  if (path === "/api/artifacts") return true;
  if (/^\/api\/artifacts\/runs\/[^/]+\/archive$/.test(path)) return true;
  if (
    /^\/api\/artifacts\/[^/]+(?:\/(?:workpiece|preview|content|proposals|workpiece\/export))?$/.test(
      path,
    )
  ) {
    return true;
  }
  return false;
}

/** How stale last_used_at must be before we re-stamp it (fire-and-forget). */
const LAST_USED_THROTTLE_MS = 60_000;

export const bearerAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = extractBearerToken(c.req.header("Authorization"));
  // Not the bearer lane - hand off to the session/public auth that follows.
  if (!token) return next();

  const key = await findActiveApiKeyByHash(hashApiKey(token));
  // Unknown or revoked -> fail closed. Do NOT fall through to session/dev-org.
  if (!key) return c.json({ error: "unauthorized" }, 401);

  // Deny by default: a valid key may only reach the explicit allowlist.
  if (!isBearerAllowedPath(c.req.method, c.req.path)) {
    return c.json({ error: "bearer_forbidden" }, 401);
  }

  // Authenticated: adopt the key's tenancy exactly as a session would, and mark
  // the request as bearer-authenticated so management routes can refuse it.
  c.set("orgId", key.orgId);
  c.set("userId", key.userId);
  c.set("bearerAuthenticated", true);

  // Throttled, fire-and-forget "last used" stamp. Off the response path; a write
  // failure must never fail the request it is annotating.
  const lastUsed = key.lastUsedAt ? key.lastUsedAt.getTime() : 0;
  if (Date.now() - lastUsed > LAST_USED_THROTTLE_MS) {
    void touchApiKeyLastUsed(key.id).catch(() => {});
  }

  return next();
});
