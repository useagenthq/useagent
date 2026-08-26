import { assertGatewayRuntimeConfiguration } from "./security/gateway-boundary";

// A deployment may give the public gateway a restricted database role without
// changing the full backend's DATABASE_URL. This assignment must happen before
// the dynamically imported app initializes the shared DB client.
if (process.env.GATEWAY_DATABASE_URL?.trim()) {
  process.env.DATABASE_URL = process.env.GATEWAY_DATABASE_URL.trim();
}
assertGatewayRuntimeConfiguration();

const { createGatewayApp } = await import("./gateway-app");

const app = createGatewayApp();
const port = Number(process.env.GATEWAY_PORT ?? 3202);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("GATEWAY_PORT must be an integer between 1 and 65535");
}

console.log(`[useagent] sandbox gateway listening on http://localhost:${port}`);

export const GATEWAY_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

export default {
  hostname: "127.0.0.1",
  port,
  fetch: app.fetch,
  idleTimeout: 255,
  // Reject oversized chunked bodies at Bun's socket boundary before a Hono
  // handler can buffer them. Individual MCP routes enforce tighter limits.
  maxRequestBodySize: GATEWAY_MAX_REQUEST_BODY_BYTES,
};
