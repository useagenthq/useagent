import { Hono, type Context } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import {
  getCurrentUserProviderConnection,
  listCurrentUserProviderConnections,
  revokeCurrentUserProviderConnection,
  upsertApiKeyProviderConnection,
} from "./service";
import {
  isProviderConnectionAuthMethod,
  isProviderConnectionProvider,
  readSafeMetadata,
} from "./types";

export const providerConnectionsRoutes = new Hono<AppEnv>();

providerConnectionsRoutes.use("*", orgScope);

function requireUserScope(c: Context<AppEnv>) {
  const userId = c.get("userId");
  if (!userId) return null;
  return { orgId: c.get("orgId"), userId };
}

providerConnectionsRoutes.get("/", async (c) => {
  const scope = requireUserScope(c);
  if (!scope) return c.json({ error: "user_required" }, 403);
  const connections = await listCurrentUserProviderConnections(scope);
  return c.json({ connections });
});

providerConnectionsRoutes.get("/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProviderConnectionProvider(provider)) {
    return c.json({ error: "unknown provider" }, 400);
  }
  const authMethod = c.req.query("authMethod");
  if (authMethod !== undefined && !isProviderConnectionAuthMethod(authMethod)) {
    return c.json({ error: "unknown auth method" }, 400);
  }
  const scope = requireUserScope(c);
  if (!scope) return c.json({ error: "user_required" }, 403);
  const connection = await getCurrentUserProviderConnection({
    ...scope,
    provider,
    authMethod,
  });
  if (!connection) return c.json({ error: "provider connection not found" }, 404);
  return c.json({ connection });
});

providerConnectionsRoutes.put("/:provider/api-key", async (c) => {
  const provider = c.req.param("provider");
  if (!isProviderConnectionProvider(provider)) {
    return c.json({ error: "unknown provider" }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  if (!apiKey) return c.json({ error: "apiKey is required" }, 400);

  const scope = requireUserScope(c);
  if (!scope) return c.json({ error: "user_required" }, 403);
  const connection = await upsertApiKeyProviderConnection({
    ...scope,
    provider,
    apiKey,
    metadata: readSafeMetadata(body.metadata),
  });
  return c.json({ connection });
});

providerConnectionsRoutes.post("/:provider/revoke", async (c) => {
  const provider = c.req.param("provider");
  if (!isProviderConnectionProvider(provider)) {
    return c.json({ error: "unknown provider" }, 400);
  }
  const authMethod = c.req.query("authMethod");
  if (authMethod !== undefined && !isProviderConnectionAuthMethod(authMethod)) {
    return c.json({ error: "unknown auth method" }, 400);
  }
  const scope = requireUserScope(c);
  if (!scope) return c.json({ error: "user_required" }, 403);
  const connection = await revokeCurrentUserProviderConnection({
    ...scope,
    provider,
    authMethod,
  });
  if (!connection) return c.json({ error: "provider connection not found" }, 404);
  return c.json({ connection });
});
