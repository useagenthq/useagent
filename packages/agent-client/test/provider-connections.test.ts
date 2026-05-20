import { describe, expect, test } from "bun:test";
import {
  decodeProviderConnectionChange,
  decodeProviderConnectionMeta,
  decodeProviderConnections,
  type ProviderConnectionChange,
  type ProviderConnectionMeta,
} from "../src/provider-connections";

const connection = {
  id: "connection-1",
  provider: "openai",
  authMethod: "chatgpt_oauth",
  status: "connected",
  metadata: {
    email: "user@example.com",
    planType: "Plus",
  },
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  revokedAt: null,
} satisfies ProviderConnectionMeta;

describe("provider connection wire contract", () => {
  test("decodes metadata-only API records and drops secret material", () => {
    const decoded = decodeProviderConnectionMeta({
      ...connection,
      metadata: {
        ...connection.metadata,
        codexHome: "/srv/codex/user",
        accessToken: "secret-token",
      },
      credentialCiphertext: "encrypted-secret",
    });

    expect(decoded).toEqual(connection);
    expect(JSON.stringify(decoded)).not.toContain("codexHome");
    expect(JSON.stringify(decoded)).not.toContain("accessToken");
    expect(JSON.stringify(decoded)).not.toContain("credentialCiphertext");
  });

  test("rejects invalid records while preserving valid historical API rows", () => {
    const historical = {
      ...connection,
      id: "connection-revoked",
      provider: "openrouter",
      authMethod: "api_key",
      status: "revoked",
      revokedAt: "2026-08-15T00:00:00.000Z",
    } satisfies ProviderConnectionMeta;

    expect(decodeProviderConnections([connection, historical])).toEqual([connection, historical]);
    expect(decodeProviderConnectionMeta({ ...connection, provider: "unknown" })).toBeNull();
    expect(decodeProviderConnectionMeta({ ...connection, status: "deleted" })).toBeNull();
  });

  test("decodes only provider-connection actions the backend publishes", () => {
    const updated = {
      type: "provider_connection",
      action: "updated",
      provider: "anthropic",
      authMethod: "api_key",
    } satisfies ProviderConnectionChange;

    expect(decodeProviderConnectionChange(updated)).toEqual(updated);
    expect(
      decodeProviderConnectionChange({
        ...updated,
        action: "revoked",
      }),
    ).toEqual({ ...updated, action: "revoked" });
    expect(
      decodeProviderConnectionChange({
        ...updated,
        action: "created",
      }),
    ).toBeNull();
  });
});
