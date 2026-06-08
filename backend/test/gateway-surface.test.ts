import { describe, expect, test } from "bun:test";
import { createGatewayApp } from "../src/gateway-app";

describe("sandbox-reachable gateway surface", () => {
  const app = createGatewayApp();

  test("exposes health but no product/session APIs", async () => {
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("x-useagent-release-fingerprint")).toBe("run-events-v1:dev");
    for (const path of ["/api/runs", "/api/config", "/api/secrets", "/api/auth/session"]) {
      expect((await app.request(path)).status).toBe(404);
    }
  });

  test("self-authenticated gateway routes are mounted", async () => {
    expect((await app.request("/api/provider/openai/v1/responses", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/mcp/knowledge", { method: "POST" })).status).toBe(401);
  });
});
