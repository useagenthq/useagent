import { describe, expect, test } from "bun:test";
import {
  decodeConnectionOwner,
  decodeConnectionProjection,
  decodeConnectionProjections,
  decodeIntegrationActionCatalog,
  decodeIntegrationActionCatalogEntry,
  decodeIntegrationConnectionChange,
  type ConnectionProjection,
  type IntegrationActionCatalogEntry,
  type IntegrationConnectionChange,
} from "../src/integrations";

const connection = {
  id: "connection-1",
  provider: "linear",
  owner: { type: "user", userId: "user-1" },
  status: "connected",
  account: {
    externalAccountId: "workspace-1",
    displayName: "Acme",
    email: "user@example.com",
    avatarUrl: "https://example.com/avatar.png",
  },
  scopes: ["read", "write"],
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
  lastVerifiedAt: "2026-08-22T00:00:00.000Z",
  revokedAt: null,
} satisfies ConnectionProjection;

const catalogEntry = {
  catalogVersion: 1,
  runtimeVersion: "1.4.0",
  runtimeCommit: "96fb6afe8c244c7d6f3a8351df06d7b04137f6a6",
  provider: "linear",
  actionId: "linear.list_issues",
  publicName: "linear.list_issues",
  description: "List issues visible to the connected Linear account.",
  inputSchema: { type: "object", properties: {} },
  effect: "read",
  approval: "none",
  timeoutMs: 10_000,
  maxResultBytes: 64_000,
  idempotent: true,
} satisfies IntegrationActionCatalogEntry;

describe("integration browser-safe wire contract", () => {
  test("decodes only valid connection owners", () => {
    expect(decodeConnectionOwner({ type: "org", userId: "must-drop" })).toEqual({ type: "org" });
    expect(decodeConnectionOwner({ type: "user", userId: " user-1 " })).toEqual({
      type: "user",
      userId: "user-1",
    });
    expect(decodeConnectionOwner({ type: "user", userId: "" })).toBeNull();
    expect(decodeConnectionOwner({ type: "system" })).toBeNull();
  });

  test("allowlists connection projection fields and drops credential material", () => {
    const decoded = decodeConnectionProjection({
      ...connection,
      account: {
        ...connection.account,
        accessToken: "must-not-cross",
        refreshToken: "must-not-cross",
      },
      credentialCiphertext: "must-not-cross",
      runtimeUrl: "http://private-runtime",
      externalConnectionId: "private-connector-id",
    });

    expect(decoded).toEqual(connection);
    const wire = JSON.stringify(decoded);
    expect(wire).not.toContain("accessToken");
    expect(wire).not.toContain("refreshToken");
    expect(wire).not.toContain("credentialCiphertext");
    expect(wire).not.toContain("runtimeUrl");
    expect(wire).not.toContain("externalConnectionId");
  });

  test("rejects malformed projections while retaining valid records from lists", () => {
    expect(decodeConnectionProjection({ ...connection, status: "deleted" })).toBeNull();
    expect(decodeConnectionProjection({ ...connection, account: null })).toBeNull();
    expect(decodeConnectionProjection({ ...connection, scopes: ["read", 42] })).toBeNull();
    expect(decodeConnectionProjection({ ...connection, revokedAt: undefined })).toBeNull();
    expect(decodeConnectionProjections([connection, { ...connection, id: "" }])).toEqual([
      connection,
    ]);
  });

  test("decodes integration connection invalidations without carrying unknown data", () => {
    const change = {
      type: "integration_connection",
      action: "health_changed",
      connectionId: "connection-1",
      provider: "linear",
      targetUserId: "user-1",
    } satisfies IntegrationConnectionChange;
    expect(decodeIntegrationConnectionChange({ ...change, secret: "must-drop" })).toEqual(change);
    expect(decodeIntegrationConnectionChange({ ...change, action: "deleted" })).toBeNull();
    expect(decodeIntegrationConnectionChange({ ...change, targetUserId: "" })).toBeNull();
  });

  test("accepts only the pinned, policy-classified safe action catalog shape", () => {
    expect(
      decodeIntegrationActionCatalogEntry({ ...catalogEntry, adminToken: "must-drop" }),
    ).toEqual(catalogEntry);
    expect(
      decodeIntegrationActionCatalogEntry({ ...catalogEntry, runtimeVersion: "latest" }),
    ).toBeNull();
    expect(
      decodeIntegrationActionCatalogEntry({ ...catalogEntry, effect: "unknown" }),
    ).toBeNull();
    expect(
      decodeIntegrationActionCatalogEntry({ ...catalogEntry, timeoutMs: 0 }),
    ).toBeNull();
    expect(decodeIntegrationActionCatalog([catalogEntry, { ...catalogEntry, approval: "always" }]))
      .toEqual([catalogEntry]);
  });
});
