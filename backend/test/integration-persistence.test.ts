import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import {
  integrationConnections,
  integrationConnectSessions,
} from "../src/db/schema";
import {
  consumeIntegrationConnectSession,
  createIntegrationConnectSession,
  findActiveIntegrationConnectSession,
  hashIntegrationConnectState,
  normalizeIntegrationReturnTo,
} from "../src/integrations/connect-sessions";
import {
  createIntegrationConnection,
  findVisibleIntegrationConnection,
  listVisibleIntegrationConnections,
  updateOwnedIntegrationConnection,
} from "../src/integrations/connection-repo";
import { uid } from "./helpers";
import { createIntegrationService } from "../src/integrations/service";
import type { DelegatedConnectionBackend } from "../src/integrations/backend";

describe("integration persistence", () => {
  test("stores only safe projections and enforces org/user visibility", async () => {
    const orgId = uid("integration-org");
    const otherOrgId = uid("integration-other-org");
    const ownerUserId = uid("integration-owner");
    const otherUserId = uid("integration-other-user");

    const orgConnection = await createIntegrationConnection({
      orgId,
      owner: { type: "org" },
      provider: "linear",
      runtimeBindingId: "runtime-1",
      externalConnectionId: "external-org",
      status: "connected",
      authMethod: "oauth2",
      account: { displayName: "Acme", accessToken: "must-not-persist" },
      scopes: ["read", " write ", "read", 42],
      createdByUserId: ownerUserId,
    });
    const userConnection = await createIntegrationConnection({
      orgId,
      owner: { type: "user", userId: ownerUserId },
      provider: "notion",
      runtimeBindingId: "runtime-1",
      externalConnectionId: "external-user",
      status: "connected",
      authMethod: "oauth2",
      account: { email: "owner@example.com", refreshToken: "must-not-persist" },
      scopes: ["pages.read"],
      createdByUserId: ownerUserId,
    });

    expect(orgConnection.account).toEqual({ displayName: "Acme" });
    expect(orgConnection.scopes).toEqual(["read", "write"]);
    expect(JSON.stringify([orgConnection, userConnection])).not.toContain("must-not-persist");

    const ownerVisible = await listVisibleIntegrationConnections({ orgId, userId: ownerUserId });
    expect(ownerVisible.map((connection) => connection.id).sort()).toEqual(
      [orgConnection.id, userConnection.id].sort(),
    );
    expect(await listVisibleIntegrationConnections({ orgId, userId: otherUserId })).toEqual([
      orgConnection,
    ]);
    expect(
      await findVisibleIntegrationConnection({
        orgId: otherOrgId,
        userId: ownerUserId,
        id: userConnection.id,
      }),
    ).toBeNull();
    expect(
      await updateOwnedIntegrationConnection({
        orgId,
        owner: { type: "user", userId: otherUserId },
        id: userConnection.id,
        status: "revoked",
        account: {},
        scopes: [],
      }),
    ).toBeNull();

    let disconnected = false;
    const service = createIntegrationService({
      managedBackends: [],
      delegatedBackends: [{
        kind: "delegated",
        runtimeBindingId: "runtime-1",
        supports: (provider) => provider === "linear",
        async listConnectableProviders() { return ["linear"]; },
        async startConnect() { throw new Error("not used"); },
        async completeConnect() { throw new Error("not used"); },
        async disconnect() { disconnected = true; },
        async listActions() { return []; },
        async executeAction() { return {}; },
      }],
    });
    await expect(
      service.disconnect({ orgId, userId: otherUserId, connectionId: orgConnection.id }),
    ).rejects.toThrow("organization admin route required");
    expect(disconnected).toBe(false);

    const [stored] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, orgConnection.id));
    expect(stored?.accountMetadata).toEqual({ displayName: "Acme" });
    expect(stored?.scopes).toEqual(["read", "write"]);
    expect(JSON.stringify(stored)).not.toContain("must-not-persist");
  });

  test("enforces owner invariants and qualified external identity uniqueness", async () => {
    const orgId = uid("integration-constraint-org");
    const userId = uid("integration-constraint-user");
    const base = {
      orgId,
      owner: { type: "org" } as const,
      provider: "linear",
      runtimeBindingId: "runtime-constraint",
      externalConnectionId: "external-constraint",
      status: "connected" as const,
      authMethod: "oauth2" as const,
      account: {},
      scopes: [],
      createdByUserId: userId,
    };
    await createIntegrationConnection(base);
    await expect(createIntegrationConnection(base)).rejects.toThrow();
    await expect(
      createIntegrationConnection({ ...base, orgId: uid("integration-distinct-org") }),
    ).resolves.toBeTruthy();
    await expect(
      createIntegrationConnection({
        ...base,
        externalConnectionId: "external-empty-user-owner",
        owner: { type: "user", userId: "" },
      }),
    ).rejects.toThrow("owner.userId is required");

    await expect((async () => {
      await db.insert(integrationConnections).values({
        orgId,
        ownerType: "org",
        ownerUserId: userId,
        provider: "linear",
        runtimeBindingId: "runtime-invalid-owner",
        externalConnectionId: "external-invalid-owner",
        status: "connected",
        authMethod: "oauth2",
        accountMetadata: {},
        scopes: [],
        createdByUserId: userId,
      });
    })()).rejects.toThrow();
  });

  test("hashes state and consumes an exact org/actor session once before expiry", async () => {
    const orgId = uid("integration-session-org");
    const actorUserId = uid("integration-session-user");
    const created = await createIntegrationConnectSession({
      orgId,
      actorUserId,
      owner: { type: "user", userId: actorUserId },
      provider: "linear",
      runtimeBindingId: "runtime-session",
      backendSessionRef: "remote-session-ref",
      returnTo: "/settings/integrations?provider=linear",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const [stored] = await db
      .select()
      .from(integrationConnectSessions)
      .where(eq(integrationConnectSessions.id, created.id));
    expect(stored?.stateHash).toBe(hashIntegrationConnectState(created.state));
    expect(JSON.stringify(stored)).not.toContain(created.state);
    expect(stored?.returnTo).toBe("/settings/integrations?provider=linear");

    expect(
      await consumeIntegrationConnectSession({
        orgId,
        actorUserId: uid("wrong-actor"),
        state: created.state,
      }),
    ).toBeNull();
    expect(
      await consumeIntegrationConnectSession({ orgId, actorUserId, state: created.state }),
    ).toMatchObject({ id: created.id, backendSessionRef: "remote-session-ref" });
    expect(
      await consumeIntegrationConnectSession({ orgId, actorUserId, state: created.state }),
    ).toBeNull();

    const expired = await createIntegrationConnectSession({
      orgId,
      actorUserId,
      owner: { type: "org" },
      provider: "linear",
      runtimeBindingId: "runtime-session",
      backendSessionRef: "expired-session-ref",
      returnTo: "/settings/integrations",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db
      .update(integrationConnectSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(integrationConnectSessions.id, expired.id));
    expect(
      await consumeIntegrationConnectSession({ orgId, actorUserId, state: expired.state }),
    ).toBeNull();
  });

  test("reads pending state without consuming it so transient backend checks can retry", async () => {
    const orgId = uid("integration-peek-org");
    const actorUserId = uid("integration-peek-user");
    const created = await createIntegrationConnectSession({
      orgId,
      actorUserId,
      owner: { type: "user", userId: actorUserId },
      provider: "linear",
      runtimeBindingId: "runtime-peek",
      backendSessionRef: "pending-connection",
      returnTo: "/settings/integrations",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await findActiveIntegrationConnectSession({ orgId, actorUserId, state: created.state }))
      .toMatchObject({ id: created.id, consumedAt: null });
    expect(await findActiveIntegrationConnectSession({ orgId, actorUserId, state: created.state }))
      .toMatchObject({ id: created.id, consumedAt: null });
  });

  test("accepts only same-origin relative return paths", () => {
    expect(normalizeIntegrationReturnTo("/settings/integrations?provider=linear")).toBe(
      "/settings/integrations?provider=linear",
    );
    for (const unsafe of [
      "https://evil.example/callback",
      "//evil.example/callback",
      "/\\evil.example/callback",
      "/%2f%2fevil.example/callback",
      "/%5cevil.example/callback",
      "settings/integrations",
    ]) {
      expect(normalizeIntegrationReturnTo(unsafe)).toBeNull();
    }
  });

  test("keeps connect state retryable until the delegated backend confirms completion", async () => {
    const orgId = uid("integration-service-org");
    const userId = uid("integration-service-user");
    let ready = false;
    const backend: DelegatedConnectionBackend = {
      kind: "delegated",
      runtimeBindingId: "fake:runtime",
      supports: (provider) => provider === "linear",
      async listConnectableProviders() { return ["linear"]; },
      async startConnect() {
        return {
          backendSessionRef: "remote-pending",
          runtimeBindingId: "fake:runtime",
          redirectUrl: "https://linear.app/oauth/authorize",
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
      async completeConnect() {
        if (!ready) throw new Error("integration authorization is not complete");
        return {
          runtimeBindingId: "fake:runtime",
          externalConnectionId: "linear-account-1",
          externalConnectionName: "work",
          authMethod: "oauth2",
          account: { displayName: "Acme Linear" },
          scopes: ["read"],
        };
      },
      async disconnect() {},
      async listActions() { return []; },
      async executeAction() { return {}; },
    };
    const service = createIntegrationService({ managedBackends: [], delegatedBackends: [backend] });
    await expect(service.listIntegrations({ orgId, userId })).resolves.toContainEqual(
      expect.objectContaining({
        provider: "linear",
        connectAvailable: true,
        connection: null,
      }),
    );
    const started = await service.startConnect({
      orgId,
      userId,
      owner: { type: "user", userId },
      provider: "linear",
      returnTo: "/settings/integrations",
    });
    await expect(service.completeConnect({ orgId, userId, state: started.state })).rejects.toThrow(
      "not complete",
    );
    ready = true;
    const connection = await service.completeConnect({ orgId, userId, state: started.state });
    expect(connection).toMatchObject({
      provider: "linear",
      status: "connected",
      account: { displayName: "Acme Linear" },
    });
    await expect(service.completeConnect({ orgId, userId, state: started.state })).rejects.toThrow(
      "invalid or expired",
    );
  });
});
