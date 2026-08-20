import { Hono } from "hono";
import { SECRET_KINDS, type SecretKind } from "../db/schema";
import type { AppEnv } from "../http";
import { orgAdminScope, orgScope } from "../middleware/org";
import { isReservedSecretName, isValidSecretName } from "./crypto";
import { deleteSecret, listSecretMeta, upsertSecret } from "./store";

// ---------------------------------------------------------------------------
// Org Secrets API (task #100). Org-scoped exactly like the knowledge/skills
// routes (orgScope resolves tenancy server-side; a client-supplied org is never
// trusted). Secret VALUES are write-only at this boundary: they can be set
// (PUT) and removed (DELETE) but NEVER read back - there is no value-returning
// endpoint by design. GET returns names + timestamps only.
// ---------------------------------------------------------------------------

export const secretsRoutes = new Hono<AppEnv>();

secretsRoutes.use("*", orgScope);

// List the active org's secret names + timestamps (never values).
secretsRoutes.get("/", async (c) => {
  const items = await listSecretMeta(c.get("orgId"));
  return c.json({ secrets: items });
});

// Upsert a secret value by name. The name must be an env-var identifier; the
// value is encrypted at rest and the response echoes metadata only.
secretsRoutes.put("/:name", orgAdminScope, async (c) => {
  const name = c.req.param("name");
  if (!isValidSecretName(name)) {
    return c.json(
      { error: "name must match ^[A-Z][A-Z0-9_]*$ (an env-var identifier)" },
      400,
    );
  }
  if (isReservedSecretName(name)) {
    return c.json(
      { error: "name is reserved for sandbox runtime control; choose a different name" },
      400,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const value = typeof body.value === "string" ? body.value : "";
  if (!value) return c.json({ error: "value is required" }, 400);

  // `kind` is optional and defaults to "env"; an explicit unknown value is a
  // client error (matching the skills `kind` check).
  let kind: SecretKind = "env";
  if (body.kind !== undefined) {
    if (
      typeof body.kind !== "string" ||
      !(SECRET_KINDS as readonly string[]).includes(body.kind)
    ) {
      return c.json({ error: `kind must be one of: ${SECRET_KINDS.join(", ")}` }, 400);
    }
    kind = body.kind as SecretKind;
  }

  const meta = await upsertSecret(c.get("orgId"), name, value, kind);
  return c.json(meta);
});

// Delete a secret by name (org-scoped). 404 when the org has no such secret.
secretsRoutes.delete("/:name", orgAdminScope, async (c) => {
  const name = c.req.param("name");
  const removed = await deleteSecret(c.get("orgId"), name);
  if (!removed) return c.json({ error: "secret not found" }, 404);
  return c.json({ deleted: true, name });
});
