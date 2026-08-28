import { Hono } from "hono";
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
  app.get("/api/health", (c) => {
    const release = currentReleaseFingerprint();
    c.header("x-useagent-release-fingerprint", release.fingerprint);
    return c.json({ status: "ok", surface: "gateway" });
  });
  app.route("/api/mcp/knowledge", knowledgeMcpRoutes);
  app.route("/api/provider", providerGatewayRoutes);
  return app;
}
