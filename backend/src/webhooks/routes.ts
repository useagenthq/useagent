import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgAdminScope, orgScope } from "../middleware/org";
import { createWebhookEndpoint, disableWebhookEndpoint, listWebhookEndpoints } from "./endpoint-store";
import { parseWebhookUrl } from "./url";

export const webhooksRoutes = new Hono<AppEnv>();

webhooksRoutes.use("*", orgScope);
webhooksRoutes.use("*", async (c, next) => {
  if (c.get("bearerAuthenticated")) return c.json({ error: "session_required" }, 403);
  return next();
});

webhooksRoutes.get("/", orgAdminScope, async (c) => {
  const webhooks = await listWebhookEndpoints(c.get("orgId"));
  return c.json({ webhooks });
});

webhooksRoutes.post("/", orgAdminScope, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "invalid webhook request" }, 400);
  }

  const value = (body as Record<string, unknown>).url;
  const url = typeof value === "string" ? parseWebhookUrl(value.trim()) : null;
  if (!url) {
    return c.json({ error: "url must be HTTPS and use a public hostname without credentials" }, 400);
  }

  const created = await createWebhookEndpoint(c.get("orgId"), url.toString());
  return c.json(created, 201);
});

webhooksRoutes.delete("/:id", orgAdminScope, async (c) => {
  const id = c.req.param("id");
  const disabled = await disableWebhookEndpoint(c.get("orgId"), id);
  if (!disabled) return c.json({ error: "webhook endpoint not found" }, 404);
  return c.json({ disabled: true, id });
});
