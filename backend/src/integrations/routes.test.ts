import { describe, expect, test } from "bun:test";
import { createIntegrationRoutes } from "./routes";

describe("public integration callbacks", () => {
  test("accepts provider-first and callback-first Slack callback paths", async () => {
    const routes = createIntegrationRoutes({ managedBackends: [], delegatedBackends: [] });
    for (const path of ["/slack/callback", "/callback/slack"]) {
      const response = await routes.request(`https://app.useagent.org${path}`);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("integration=error");
    }
  });
});
