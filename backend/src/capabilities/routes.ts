import { Hono } from "hono";
import { memoryConfig, slackConfig } from "../env";
import type { AppEnv } from "../http";
import { toolGatewayConfig } from "../knowledge/gateway/config";
import { gcsConfiguredForOrg } from "../knowledge/gateway/gcs-tools";
import { providerGatewayConfig } from "../provider-gateway/config";
import { productChildThreadsEnabled } from "../runs/thread-relationship-rollout";
import { orgScope } from "../middleware/org";
import { buildCapabilityCatalog, type CapabilityCatalog } from "./catalog";

export interface CapabilityCatalogRouteDependencies {
  readonly catalog?: () => CapabilityCatalog;
}

export function createCapabilityCatalogRoutes(
  dependencies: CapabilityCatalogRouteDependencies = {},
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("*", orgScope);
  routes.get("/", async (c) => {
    if (dependencies.catalog) return c.json(dependencies.catalog());
    const gatewayConfigured = toolGatewayConfig() !== null;
    return c.json(buildCapabilityCatalog({
      gatewayConfigured,
      slackConfigured: slackConfig() !== null,
      webSearchConfigured: providerGatewayConfig() !== null,
      memoryConfigured: memoryConfig() !== null,
      gcsConfigured: await gcsConfiguredForOrg(c.get("orgId")),
      childSessionsConfigured: gatewayConfigured,
      productChildThreadsConfigured: productChildThreadsEnabled(c.get("orgId")),
    }));
  });
  return routes;
}

export const capabilityCatalogRoutes = createCapabilityCatalogRoutes();
