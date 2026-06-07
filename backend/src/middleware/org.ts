import { createMiddleware } from "hono/factory";
import { and, eq } from "drizzle-orm";
import { auth } from "../auth";
import { db } from "../db/client";
import { member } from "../db/schema";
import { allowDevOrg } from "../env";
import type { AppEnv } from "../http";
import { firstOrgForUser, getDevContext } from "../seed";

/**
 * Resolve the active org + user for a request. Tenancy is server-resolved only —
 * never trusted from a caller-supplied header or body.
 *
 *  - Valid session → its user + active organization, falling back to the user's
 *    first membership. A session with ZERO memberships is rejected 403
 *    (`no_organization`) — it never silently borrows the dev org.
 *  - No (or invalid) session:
 *      · dev-org allowed → the seeded dev org + dev user, so every API stays
 *        usable unauthenticated in local dev;
 *      · dev-org disallowed (ALLOW_DEV_ORG=0, or production) → 401 on all
 *        domain routes. Flipping ALLOW_DEV_ORG off is the production switch.
 */
// Prefixes that carry their OWN auth boundary (or are legitimately public) and
// so are NOT org-session scoped. Everything else under /api/* is org-scoped by
// the universal adapter (fail closed): a new route is protected unless its prefix
// is listed here on purpose.
//   /api/health, /api/config  - public, secret-free (health probe + client config)
//   /api/auth/                - better-auth's own login/session endpoints
//   /api/slack/               - Slack request-signature verified (slack/verify.ts)
const PUBLIC_API_EXACT = new Set([
  "/api/health",
  "/api/config",
  "/api/internal/artifact-changes",
  "/api/internal/automation",
  // Child-session lane bridge - authenticates its own short-lived run
  // capability exactly like /api/internal/automation.
  "/api/internal/child-sessions",
  "/api/internal/gateway-approval/consume",
  // Approval-request lane bridge - authenticates its own short-lived run
  // capability exactly like /api/internal/automation.
  "/api/internal/gateway-approval-requests",
  // GitHub gateway lane - authenticates and revalidates its short-lived run
  // capability before backend-only GitHub credentials can be resolved.
  "/api/internal/github-operations",
]);
const PUBLIC_API_PREFIXES = [
  "/api/auth/",
  "/api/slack/",
  // One-use, short-lived run capabilities authenticate this WebSocket. The
  // relay re-resolves the exact org/user connection before start and every turn.
  "/api/internal/codex-relay/",
  // Operator dispatch bridge: dedicated-secret authenticated, verifies Bun's
  // socket peer is loopback, and rejects proxy-origin headers.
  "/api/internal/operator/",
];

/** True when `path` authenticates itself (or is public) and must NOT be forced
 *  through org-session scoping. Pure + exported so the fail-closed default is
 *  unit-testable: any path not covered here is treated as protected. */
export function isPublicApiPath(path: string): boolean {
  if (PUBLIC_API_EXACT.has(path)) return true;
  return PUBLIC_API_PREFIXES.some((p) => path.startsWith(p));
}

export const orgScope = createMiddleware<AppEnv>(async (c, next) => {
  // Idempotent: if a request already resolved its org (the universal auth adapter
  // in index.ts runs orgScope first for every non-public /api/* path), a second
  // application is a no-op instead of a duplicate getSession round-trip. Lets the
  // adapter be the fail-closed default while per-router `.use(orgScope)` guards
  // stay in place as defense-in-depth without paying twice.
  if (c.get("orgId")) return next();

  let session: Awaited<ReturnType<typeof auth.api.getSession>> = null;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers });
  } catch {
    // Treat an unresolvable/invalid session as anonymous (handled below).
    session = null;
  }

  if (session) {
    const userId = session.user.id;
    const orgId =
      session.session.activeOrganizationId ?? (await firstOrgForUser(userId));
    if (!orgId) {
      // Authenticated but belongs to no organization — never fall back to the
      // dev org (that would cross tenancy). Fail closed.
      return c.json({ error: "no_organization" }, 403);
    }
    c.set("orgId", orgId);
    c.set("userId", userId);
    return next();
  }

  // Anonymous (or invalid session) below.
  if (!allowDevOrg()) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const dev = getDevContext();
  c.set("orgId", dev.orgId);
  c.set("userId", dev.userId);
  return next();
});

/** Secret/configuration mutation is an organization-administration operation.
 * A normal member may use the org's configured integrations but cannot change
 * executable sandbox inputs or rotate credentials. */
export const orgAdminScope = createMiddleware<AppEnv>(async (c, next) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  if (!orgId || !userId) return c.json({ error: "forbidden" }, 403);

  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  if (membership?.role !== "owner" && membership?.role !== "admin") {
    return c.json({ error: "organization_admin_required" }, 403);
  }
  return next();
});
