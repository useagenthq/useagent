import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { createApiKey, listApiKeys, revokeApiKey } from "./store";

// ---------------------------------------------------------------------------
// API-key management API. SESSION AUTH ONLY and org-scoped: a bearer key can
// NEVER mint or revoke keys. Minting is not on the bearer allowlist (so
// middleware/bearer.ts 401s a key here before the route runs); the explicit
// bearer guard below refuses too, as defense-in-depth if that allowlist ever
// regressed. The plaintext secret is returned ONCE by POST and never again.
// ---------------------------------------------------------------------------

export const apiKeysRoutes = new Hono<AppEnv>();

// Idempotent with the universal adapter; keeps tenancy resolution explicit here.
apiKeysRoutes.use("*", orgScope);

// A bearer-authenticated request must never reach key management.
apiKeysRoutes.use("*", async (c, next) => {
  if (c.get("bearerAuthenticated")) return c.json({ error: "session_required" }, 403);
  return next();
});

const MAX_NAME_LEN = 100;

// Mint a new key for the active org, owned by the signed-in user. The response
// carries the plaintext secret ONE TIME; only its hash + prefix are stored.
apiKeysRoutes.post("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);
  if (name.length > MAX_NAME_LEN) {
    return c.json({ error: `name must be ${MAX_NAME_LEN} characters or fewer` }, 400);
  }

  const created = await createApiKey(c.get("orgId"), userId, name);
  return c.json(created, 201);
});

// List the signed-in member's keys in the active org (metadata only).
apiKeysRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const keys = await listApiKeys(c.get("orgId"), userId);
  return c.json({ keys });
});

// Revoke one of the signed-in member's keys (soft delete: stamps revoked_at,
// keeps the row). A different member's id is indistinguishable from a miss.
apiKeysRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  const revoked = await revokeApiKey(c.get("orgId"), userId, id);
  if (!revoked) return c.json({ error: "api key not found" }, 404);
  return c.json({ revoked: true, id });
});
