import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgAdminScope, orgScope } from "../middleware/org";
import { createIntegrationService, type IntegrationServiceDependencies } from "./service";

function errorStatus(message: string): 400 | 403 | 404 | 409 | 503 {
  if (message.includes("admin route required")) return 403;
  if (message.includes("not found")) return 404;
  if (message.includes("unavailable")) return 503;
  if (message.includes("not connectable") || message.includes("already consumed")) return 409;
  return 400;
}

export function createIntegrationRoutes(deps?: IntegrationServiceDependencies): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const service = createIntegrationService(deps);
  routes.use("*", orgScope);

  routes.get("/", async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    return c.json({
      integrations: await service.listIntegrations({ orgId: c.get("orgId"), userId }),
    });
  });

  routes.post("/:provider/connect", async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const result = await service.startConnect({
        orgId: c.get("orgId"),
        userId,
        provider: c.req.param("provider"),
        returnTo: typeof body.returnTo === "string" ? body.returnTo : "/settings/integrations",
        owner: { type: "user", userId },
      });
      return c.json(result);
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  routes.post("/:provider/connect/org", orgAdminScope, async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const result = await service.startConnect({
        orgId: c.get("orgId"),
        userId,
        provider: c.req.param("provider"),
        returnTo: typeof body.returnTo === "string" ? body.returnTo : "/settings/integrations",
        owner: { type: "org" },
      });
      return c.json(result);
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  routes.post("/callback", async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.state !== "string" || !body.state) {
      return c.json({ error: "state is required" }, 400);
    }
    try {
      const connection = await service.completeConnect({
        orgId: c.get("orgId"),
        userId,
        state: body.state,
      });
      return c.json({ connection });
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  routes.delete("/:provider", async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    const connectionId = c.req.query("connectionId");
    if (!connectionId) return c.json({ error: "connectionId is required" }, 400);
    try {
      const connection = await service.disconnect({
        orgId: c.get("orgId"),
        userId,
        connectionId,
        provider: c.req.param("provider"),
      });
      return c.json({ connection });
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  routes.delete("/:provider/org", orgAdminScope, async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    const connectionId = c.req.query("connectionId");
    if (!connectionId) return c.json({ error: "connectionId is required" }, 400);
    try {
      const connection = await service.disconnect({
        orgId: c.get("orgId"),
        userId,
        connectionId,
        provider: c.req.param("provider"),
        allowOrgOwner: true,
      });
      return c.json({ connection });
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  return routes;
}

export const integrationRoutes = createIntegrationRoutes();
