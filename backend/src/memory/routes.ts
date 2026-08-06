import { Hono } from "hono";
import { auth } from "../auth";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import {
  listCapturesForOrg,
  resolveDeliveringOrphan,
  retryDeadCapture,
  type OrphanResolution,
} from "./capture-outbox";
import { listRecallsForOrg } from "./retrieval-ledger";
import { isMemoryScope, resolveScopedMemory, type MemoryScope } from "./scope";
import {
  browseScopedMemory,
  deleteScopedMemory,
  searchScopedMemory,
  updateScopedMemory,
  type MemoryIdentity,
} from "./team-memory";

/**
 * Memory Hub API — mounted at /api/memory. The human control surface over the
 * team-memory pools (TencentDB MemoryCore) plus our own capture outbox and
 * retrieval ledger. Org-scoped by `orgScope` exactly like /api/knowledge; the
 * memory transport credentials NEVER leave the backend.
 *
 * Scope model mirrors the runtime (src/memory/scope.ts): an "org" request reads/
 * writes the shared org pool; a "personal" request reads personal+org (personal
 * first) and writes the personal pool — and FAILS CLOSED when there is no
 * authenticated user (the dev-org fallback has no real user), never borrowing the
 * dev identity to invent a personal pool.
 */
export const memoryRoutes = new Hono<AppEnv>();

memoryRoutes.use("*", orgScope);

/** The synthetic "run" the Hub resolves a memory plan from. `userId` is the REAL
 *  authenticated user (or null) — NOT the org-scope dev fallback — so personal
 *  scope fails closed for an unauthenticated caller just like a real run. */
function planFor(orgId: string, authedUserId: string | null, scope: MemoryScope) {
  return resolveScopedMemory({
    orgId,
    userId: authedUserId,
    threadId: "memory-hub",
    id: "memory-hub",
    memoryScope: scope,
  });
}

/** The single pool identity to mutate for a target scope (org pool, or the
 *  personal pool when a real user is present). Null ⇒ memory disabled OR a
 *  fail-closed personal request. */
function poolIdentityFor(
  orgId: string,
  authedUserId: string | null,
  scope: MemoryScope,
): MemoryIdentity | null {
  return planFor(orgId, authedUserId, scope)?.writePool?.identity ?? null;
}

/** Resolve the real better-auth user id for THIS request (null when anonymous /
 *  dev-org fallback). Distinct from `c.get("userId")`, which the org middleware
 *  also fills with the dev user — personal scope must not trust that. */
async function authedUserId(headers: Headers): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers });
    return session?.user.id ?? null;
  } catch {
    return null;
  }
}

/** Read + validate the `scope` query param (default "org"). */
function readScope(raw: string | undefined): MemoryScope {
  return isMemoryScope(raw) ? raw : "org";
}

// GET /api/memory/search?scope=org|personal&q=... — search-driven recall,
// mirroring the runtime's per-run recall. Labeled items ([org]/[personal]) with
// citations. Personal + unauthenticated → an honest fail-closed empty result.
memoryRoutes.get("/search", async (c) => {
  const scope = readScope(c.req.query("scope"));
  const query = (c.req.query("q") ?? "").trim();
  const uid = await authedUserId(c.req.raw.headers);
  const plan = planFor(c.get("orgId"), uid, scope);
  if (!plan) return c.json({ enabled: false, scope, authed: uid !== null, items: [] });
  // Personal scope with no authenticated user: fail closed (no pools to read).
  if (scope === "personal" && uid === null) {
    return c.json({ enabled: true, scope, authed: false, items: [], failedClosed: true });
  }
  if (!query) return c.json({ enabled: true, scope, authed: uid !== null, items: [] });
  try {
    const recall = await searchScopedMemory(query, plan.readPools);
    return c.json({
      enabled: true,
      scope,
      authed: uid !== null,
      truncated: recall.truncated,
      latencyMs: recall.latencyMs,
      items: recall.items.map((it) => ({
        content: it.content,
        sourceScope: it.sourceScope,
        citation: it.citation,
      })),
    });
  } catch (e) {
    console.error("[memory] search error:", (e as Error).message);
    return c.json({ error: "search failed" }, 500);
  }
});

// GET /api/memory/browse?scope=org|personal — the first-class stored-memory list
// for the viewed pool (org pool, or the personal pool). atomic/query, newest
// first. Personal + unauthenticated → fail-closed empty.
memoryRoutes.get("/browse", async (c) => {
  const scope = readScope(c.req.query("scope"));
  const uid = await authedUserId(c.req.raw.headers);
  const plan = planFor(c.get("orgId"), uid, scope);
  if (!plan) return c.json({ enabled: false, scope, authed: uid !== null, items: [], total: 0 });
  if (scope === "personal" && uid === null) {
    return c.json({ enabled: true, scope, authed: false, items: [], total: 0, failedClosed: true });
  }
  // Browse the VIEWED pool only (writePool) — the "memory stored in this pool".
  // Search above still spans personal+org for a personal recall (runtime parity).
  const pool = plan.writePool;
  if (!pool) return c.json({ enabled: true, scope, authed: uid !== null, items: [], total: 0 });
  try {
    const browse = await browseScopedMemory([pool]);
    return c.json({
      enabled: true,
      scope,
      authed: uid !== null,
      total: browse.total,
      latencyMs: browse.latencyMs,
      items: browse.items,
    });
  } catch (e) {
    console.error("[memory] browse error:", (e as Error).message);
    return c.json({ error: "browse failed" }, 500);
  }
});

// PATCH /api/memory/item/:id — CORRECT a stored fact (content + optional
// background) in its pool via atomic/update. Pool-scoped by identity: a caller
// can only edit memory in a pool they own.
memoryRoutes.patch("/item/:id", async (c) => {
  let body: { scope?: unknown; content?: unknown; background?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const scope = readScope(typeof body.scope === "string" ? body.scope : undefined);
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return c.json({ error: "`content` is required" }, 400);
  const background = typeof body.background === "string" ? body.background : undefined;
  const uid = await authedUserId(c.req.raw.headers);
  const identity = poolIdentityFor(c.get("orgId"), uid, scope);
  if (!identity) {
    return c.json({ error: scope === "personal" ? "sign-in required" : "memory disabled" }, 403);
  }
  try {
    const ok = await updateScopedMemory(identity, c.req.param("id"), content, background);
    if (!ok) return c.json({ error: "update failed" }, 502);
    return c.json({ ok: true });
  } catch (e) {
    console.error("[memory] correct error:", (e as Error).message);
    return c.json({ error: "update failed" }, 500);
  }
});

// DELETE /api/memory/item/:id?scope=org|personal — DELETE a stored fact from its
// pool via atomic/delete. Pool-scoped by identity.
memoryRoutes.delete("/item/:id", async (c) => {
  const scope = readScope(c.req.query("scope"));
  const uid = await authedUserId(c.req.raw.headers);
  const identity = poolIdentityFor(c.get("orgId"), uid, scope);
  if (!identity) {
    return c.json({ error: scope === "personal" ? "sign-in required" : "memory disabled" }, 403);
  }
  try {
    const deletedCount = await deleteScopedMemory(identity, [c.req.param("id")]);
    if (deletedCount === 0) return c.json({ error: "not found in this pool" }, 404);
    return c.json({ ok: true, deletedCount });
  } catch (e) {
    console.error("[memory] delete error:", (e as Error).message);
    return c.json({ error: "delete failed" }, 500);
  }
});

// GET /api/memory/captures — our OWN capture-outbox rows for this org: the
// envelopes we sent (or are trying to), with delivered/pending/dead/delivering
// state. The at-most-once `delivering` orphans surface here for manual recovery.
memoryRoutes.get("/captures", async (c) => {
  try {
    const captures = await listCapturesForOrg(c.get("orgId"));
    return c.json({ captures });
  } catch (e) {
    console.error("[memory] captures error:", (e as Error).message);
    return c.json({ error: "captures failed" }, 500);
  }
});

// POST /api/memory/captures/:runId/retry — manually re-enqueue a DEAD capture
// (fresh attempt budget; committed payload + destination scope preserved).
memoryRoutes.post("/captures/:runId/retry", async (c) => {
  try {
    const ok = await retryDeadCapture(c.req.param("runId"), c.get("orgId"));
    if (!ok) return c.json({ error: "no dead capture for this run in your org" }, 404);
    return c.json({ ok: true });
  } catch (e) {
    console.error("[memory] retry error:", (e as Error).message);
    return c.json({ error: "retry failed" }, 500);
  }
});

// POST /api/memory/captures/:runId/resolve — resolve a crash-orphaned
// `delivering` row: {resolution:"delivered"|"discard"}. The documented manual
// inspection path for the at-most-once outbox, made operable.
memoryRoutes.post("/captures/:runId/resolve", async (c) => {
  let body: { resolution?: unknown };
  try {
    body = (await c.req.json()) as { resolution?: unknown };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.resolution !== "delivered" && body.resolution !== "discard") {
    return c.json({ error: "`resolution` must be 'delivered' or 'discard'" }, 400);
  }
  try {
    const ok = await resolveDeliveringOrphan(
      c.req.param("runId"),
      c.get("orgId"),
      body.resolution as OrphanResolution,
    );
    if (!ok) return c.json({ error: "no delivering orphan for this run in your org" }, 404);
    return c.json({ ok: true });
  } catch (e) {
    console.error("[memory] resolve error:", (e as Error).message);
    return c.json({ error: "resolve failed" }, 500);
  }
});

// GET /api/memory/recalls — "Recently recalled": per-run recall frames from the
// retrieval ledger, each linking back to /session/{runId}.
memoryRoutes.get("/recalls", async (c) => {
  try {
    const recalls = await listRecallsForOrg(c.get("orgId"));
    return c.json({ recalls });
  } catch (e) {
    console.error("[memory] recalls error:", (e as Error).message);
    return c.json({ error: "recalls failed" }, 500);
  }
});

export default memoryRoutes;
