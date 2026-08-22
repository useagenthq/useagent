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
});
