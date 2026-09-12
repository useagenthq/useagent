import { Hono, type Context } from "hono";
import { artifactStorageHealth } from "./artifacts/storage";
import { knowledgeMcpRoutes } from "./knowledge/gateway/mcp";
import { providerGatewayRoutes } from "./provider-gateway/routes";
import { currentReleaseFingerprint } from "./release";

/**
 * The only application that should sit behind the sandbox-reachable public
 * origin. It deliberately has no session auth, org APIs, runs, secrets, CORS,
 * scheduler, or worker loops: both mounted surfaces authenticate capabilities.
 */
export function createGatewayApp(): Hono {
  const app = new Hono();
  // Health includes the artifact store: the gateway is the process every
  // harness publishes through, so "listening" without a writable store is down.
  const health = async (c: Context) => {
    const release = currentReleaseFingerprint();
    c.header("x-useagent-release-fingerprint", release.fingerprint);
    const storage = await artifactStorageHealth();
    if (!storage.ok) {
      return c.json({ status: "unhealthy", surface: "gateway", artifact_storage: storage.error }, 503);
    }
    return c.json({ status: "ok", surface: "gateway" });
  };
  app.get("/health", health);
  app.get("/api/health", health);
  app.route("/api/mcp/knowledge", knowledgeMcpRoutes);
  app.route("/api/provider", providerGatewayRoutes);
  return app;
}
