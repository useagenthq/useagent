import { Hono } from "hono";
import { memoryConfig, slackConfig } from "../env";
import type { AppEnv } from "../http";
import { toolGatewayConfig } from "../knowledge/gateway/config";
import { gcsConfiguredForOrg } from "../knowledge/gateway/gcs-tools";
import { providerGatewayConfig } from "../provider-gateway/config";
import { productChildThreadsEnabled } from "../runs/thread-relationship-rollout";
import { botsEnabled } from "../bots/rollout";
import { orgScope } from "../middleware/org";
import { configuredUserFacingEngines } from "../runs/engine-readiness";
import { buildCapabilityCatalog, type CapabilityCatalog } from "./catalog";
import {
  nativeCodexModelCatalog,
  type NativeCodexModelCatalog,
} from "../provider-connections/codex-model-catalog";

export interface CapabilityCatalogRouteDependencies {
  readonly catalog?: () => CapabilityCatalog | Promise<CapabilityCatalog>;
  readonly codexModels?: (
    scope: { readonly orgId: string; readonly userId: string },
    force: boolean,
  ) => Promise<NativeCodexModelCatalog>;
}

export function createCapabilityCatalogRoutes(
  dependencies: CapabilityCatalogRouteDependencies = {},
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("*", orgScope);
  routes.get("/", async (c) => {
    if (dependencies.catalog) return c.json(await dependencies.catalog());
    const gatewayConfigured = toolGatewayConfig() !== null;
    const orgId = c.get("orgId");
    const userId = c.get("userId");
    if (!orgId || !userId) return c.json({ error: "unauthorized" }, 401);
    const codexModelCatalog = configuredUserFacingEngines().includes("codex")
      ? await (dependencies.codexModels ?? ((scope, force) =>
          nativeCodexModelCatalog(scope, { force })))(
          { orgId, userId },
          c.req.query("refresh") === "models",
        )
      : undefined;
    return c.json(buildCapabilityCatalog({
      gatewayConfigured,
      slackConfigured: slackConfig() !== null,
      webSearchConfigured: providerGatewayConfig() !== null,
      memoryConfigured: memoryConfig() !== null,
      gcsConfigured: await gcsConfiguredForOrg(c.get("orgId")),
      childSessionsConfigured: gatewayConfigured,
      productChildThreadsConfigured: productChildThreadsEnabled(c.get("orgId")),
      botsConfigured: botsEnabled(c.get("orgId")),
      ...(codexModelCatalog ? { codexModelCatalog } : {}),
    }));
  });
  return routes;
}

export const capabilityCatalogRoutes = createCapabilityCatalogRoutes();
