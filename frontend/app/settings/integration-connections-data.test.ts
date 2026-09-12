import { describe, expect, test } from "bun:test";
import {
  decodeIntegrationSummaries,
  decodeIntegrationSummary,
  integrationAuthLabel,
  integrationPermissionLabels,
} from "./integration-connections-data";

const permissions = { scopes: [], actionCount: 0, effects: [], approvals: [] } as const;

describe("integration summary wire decoder", () => {
  test("fails lifecycle capabilities closed when the backend omits them", () => {
    expect(
      decodeIntegrationSummary({
        provider: "github",
        displayName: "GitHub",
        description: "Native repository workflows.",
        backend: "native",
        authMethod: "custom_credential",
        managed: true,
        configured: true,
        status: "connected",
        degradationReason: null,
        permissions,
        connection: null,
      }),
    ).toMatchObject({
      provider: "github",
      managed: true,
      connectAvailable: false,
      disconnectAvailable: false,
    });
  });

  test("drops an entry whose browser-safe connection projection is malformed", () => {
    expect(
      decodeIntegrationSummaries([
        {
          provider: "linear",
          displayName: "Linear",
          description: "Issue tracking.",
          backend: "openconnector",
          authMethod: "oauth2",
          managed: false,
          configured: true,
          connectAvailable: true,
          disconnectAvailable: false,
          status: "unavailable",
          degradationReason: null,
          permissions,
          connection: { id: "secret-only-partial-object" },
        },
      ]),
    ).toEqual([]);
  });

  test("presents only backend-confirmed auth and action permission facts", () => {
    const summary = decodeIntegrationSummary({
      provider: "linear",
      displayName: "Linear",
      description: "Issue tracking.",
      backend: "openconnector",
      authMethod: "oauth2",
      managed: false,
      configured: true,
      connectAvailable: true,
      disconnectAvailable: true,
      status: "connected",
      degradationReason: null,
      permissions: {
        scopes: ["issues:read", "issues:write"],
        actionCount: 4,
        effects: ["read", "write"],
        approvals: ["none", "interactive"],
      },
      connection: null,
    });
    if (!summary) throw new Error("expected a valid integration summary");
    expect(integrationAuthLabel(summary)).toBe("OAuth 2.0");
    expect(integrationPermissionLabels(summary)).toEqual([
      "2 scopes",
      "4 actions",
      "Read actions",
      "Write actions",
      "Approval required",
    ]);
  });
});
