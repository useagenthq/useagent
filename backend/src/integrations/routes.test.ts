import { describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "../db/client";
import type { DelegatedConnectionBackend } from "./backend";
import { createIntegrationRoutes } from "./routes";

await migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` });

describe("public integration callbacks", () => {
  test("accepts provider-first and callback-first Slack callback paths", async () => {
    const routes = createIntegrationRoutes({ managedBackends: [], delegatedBackends: [] });
    for (const path of ["/slack/callback", "/callback/slack"]) {
      const response = await routes.request(`https://app.useagent.org${path}`);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("integration=error");
    }
  });

  test("GET returns curated and generic configured providers without connector mechanisms", async () => {
    const backend: DelegatedConnectionBackend = {
      kind: "delegated",
      catalogBackend: "openconnector",
      catalogAuthMethod: "oauth2",
      runtimeBindingId: "test:connector-runtime",
      disconnectSupported: true,
      supports: () => true,
      async listConnectableProviders() {
        return ["linear", "airtable", "openconnector"];
      },
      async startConnect() {
        throw new Error("not used");
      },
      async completeConnect() {
        throw new Error("not used");
      },
      async disconnect() {
        throw new Error("not used");
      },
      async listActions() {
        return [];
      },
      async executeAction() {
        throw new Error("not used");
      },
    };
    const routes = createIntegrationRoutes({ managedBackends: [], delegatedBackends: [backend] });
    const response = await routes.request("https://app.useagent.org/");
    expect(response.status).toBe(200);
    const payload = await response.json() as { integrations: Array<Record<string, unknown>> };
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain("runtimeBindingId");
    expect(wire).not.toContain("test:connector-runtime");
    const providers = payload.integrations.map((integration) => integration.provider);
    expect(providers).toContain("airtable");
    expect(providers).not.toContain("openconnector");
    expect(payload.integrations.find((integration) => integration.provider === "airtable"))
      .toMatchObject({
        displayName: "Airtable",
        backend: "openconnector",
        authMethod: "oauth2",
        configured: true,
        connectAvailable: true,
        status: "unavailable",
        degradationReason: null,
        permissions: { scopes: [], actionCount: 0, effects: [], approvals: [] },
      });
  });
});
