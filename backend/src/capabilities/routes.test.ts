import { afterEach, describe, expect, test } from "bun:test";
import type { CapabilityCatalog } from "./catalog";
import { createCapabilityCatalogRoutes } from "./routes";

const previousAllowDevOrg = process.env.ALLOW_DEV_ORG;

afterEach(() => {
  if (previousAllowDevOrg === undefined) delete process.env.ALLOW_DEV_ORG;
  else process.env.ALLOW_DEV_ORG = previousAllowDevOrg;
});

describe("capability catalog route", () => {
  test("is authenticated", async () => {
    process.env.ALLOW_DEV_ORG = "0";
    const response = await createCapabilityCatalogRoutes().request("/");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("returns the injected browser-safe catalog for an authenticated dev org", async () => {
    process.env.ALLOW_DEV_ORG = "1";
    const catalog = {
      version: 1,
      scope: "pre_run",
      bots: false,
      engines: [],
      tools: { gatewayConfigured: false, families: {}, declared: [] },
      nativeSlashCommands: { catalog: "session_runtime", currentRun: null },
    } satisfies CapabilityCatalog;
    const response = await createCapabilityCatalogRoutes({ catalog: () => catalog }).request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalog);
  });
});
