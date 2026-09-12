import { describe, expect, test } from "bun:test";
import {
  integrationCatalogDefinition,
  isUserFacingIntegrationProvider,
  summarizeIntegrationPermissions,
} from "./catalog";
import { selectProviderConnection } from "./service";

describe("integration provider catalog", () => {
  test("keeps connector mechanisms out of provider discovery", () => {
    expect(isUserFacingIntegrationProvider("openconnector")).toBe(false);
    expect(isUserFacingIntegrationProvider("oomol_connector")).toBe(false);
    expect(isUserFacingIntegrationProvider("linear")).toBe(true);
  });

  test("uses curated metadata first and neutral metadata for discovered providers", () => {
    expect(integrationCatalogDefinition("github")).toMatchObject({
      displayName: "GitHub",
    });
    expect(integrationCatalogDefinition("google_calendar")).toEqual({
      provider: "google_calendar",
      displayName: "Google Calendar",
      description: "Google Calendar account connection.",
    });
  });

  test("bounds scopes and summarizes actual action policy", () => {
    const permissions = summarizeIntegrationPermissions({
      scopes: [...Array.from({ length: 40 }, (_, index) => `scope:${index}`), "scope:0"],
      actions: [
        {
          catalogVersion: 1,
          runtimeVersion: "test",
          runtimeCommit: null,
          provider: "linear",
          actionId: "linear.list",
          publicName: "list",
          description: "List issues",
          inputSchema: {},
          effect: "read",
          approval: "none",
          timeoutMs: 1_000,
          maxResultBytes: 1_000,
          idempotent: true,
        },
        {
          catalogVersion: 1,
          runtimeVersion: "test",
          runtimeCommit: null,
          provider: "linear",
          actionId: "linear.create",
          publicName: "create",
          description: "Create issue",
          inputSchema: {},
          effect: "write",
          approval: "interactive",
          timeoutMs: 1_000,
          maxResultBytes: 1_000,
          idempotent: false,
        },
      ],
    });
    expect(permissions.scopes).toHaveLength(32);
    expect(permissions).toMatchObject({
      actionCount: 2,
      effects: ["read", "write"],
      approvals: ["none", "interactive"],
    });
  });
});

describe("integration provider connection selection", () => {
  test("prefers health, then the current user's connection, then newest", () => {
    const at = (createdAt: string, ownerType: "org" | "user", status: "connected" | "unhealthy") => ({
      createdAt: new Date(createdAt),
      ownerType,
      status,
    });
    expect(selectProviderConnection([
      at("2026-01-03", "user", "unhealthy"),
      at("2026-01-01", "org", "connected"),
    ])?.ownerType).toBe("org");
    expect(selectProviderConnection([
      at("2026-01-03", "org", "connected"),
      at("2026-01-01", "user", "connected"),
    ])?.ownerType).toBe("user");
    expect(selectProviderConnection([
      at("2026-01-01", "user", "connected"),
      at("2026-01-02", "user", "connected"),
    ])?.createdAt.toISOString()).toContain("2026-01-02");
  });
});
