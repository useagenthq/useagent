import { createMiddleware } from "hono/factory";
import { auth } from "../auth";
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
export const orgScope = createMiddleware<AppEnv>(async (c, next) => {
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
