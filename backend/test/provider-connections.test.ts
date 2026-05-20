import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { member, providerConnections, user } from "../src/db/schema";
import {
  getTrustedProviderCredential,
  storeTrustedChatGptOAuthProviderConnection,
} from "../src/provider-connections/service";
import { createOrgSession, fetchApi, json, uid } from "./helpers";

function assertNoCredentialMaterial(value: unknown, secret: string): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(secret);
  for (const field of ["apiKey", "value", "accessToken", "refreshToken", "credentialCiphertext", "iv", "tag"]) {
    expect(serialized).not.toContain(`"${field}"`);
  }
}

describe("provider connections", () => {
  async function userIdForEmail(email: string): Promise<string> {
    const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (!account) throw new Error(`missing test user ${email}`);
    return account.id;
  }

  test("API-key upsert stores ciphertext at rest and responses are write-only", async () => {
    const session = await createOrgSession("pc-write");
    const apiKey = `sk-test-${crypto.randomUUID()}`;

    const put = await json<any>("/api/provider-connections/openai/api-key", {
      method: "PUT",
      cookies: session.cookies,
      body: {
        apiKey,
        metadata: {
          email: "person@example.com",
          planType: "team",
          accessToken: "must-not-persist-as-metadata",
        },
      },
    });
    expect(put.status).toBe(200);
    expect(put.body.connection.provider).toBe("openai");
    expect(put.body.connection.authMethod).toBe("api_key");
    expect(put.body.connection.status).toBe("connected");
    expect(put.body.connection.metadata).toEqual({
      email: "person@example.com",
      planType: "team",
    });
    assertNoCredentialMaterial(put.body, apiKey);

    const [row] = await db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.orgId, session.orgId),
          eq(providerConnections.provider, "openai"),
          eq(providerConnections.authMethod, "api_key"),
        ),
      );
    expect(row).toBeTruthy();
    expect(row!.credentialCiphertext).not.toContain(apiKey);
    expect(row!.credentialCiphertext).not.toBe(apiKey);
    expect(row!.metadata).toEqual({ email: "person@example.com", planType: "team" });

    const list = await json<any>("/api/provider-connections", {
      cookies: session.cookies,
    });
    expect(list.status).toBe(200);
    expect(list.body.connections).toHaveLength(1);
    assertNoCredentialMaterial(list.body, apiKey);

    const trusted = await getTrustedProviderCredential({
      orgId: session.orgId,
      userId: row!.userId,
      provider: "openai",
      authMethod: "api_key",
    });
    expect(trusted).toEqual({ authMethod: "api_key", value: apiKey });
  });

  test("connections are isolated by user and organization for read, update, and revoke", async () => {
    const a = await createOrgSession("pc-a");
    const b = await createOrgSession("pc-b");
    const keyA = `sk-a-${crypto.randomUUID()}`;
    const keyB = `sk-b-${crypto.randomUUID()}`;

    expect(
      (await json("/api/provider-connections/anthropic/api-key", {
        method: "PUT",
        cookies: a.cookies,
        body: { apiKey: keyA, metadata: { email: "a@example.com" } },
      })).status,
    ).toBe(200);

    const listB1 = await json<any>("/api/provider-connections", { cookies: b.cookies });
    expect(listB1.status).toBe(200);
    expect(listB1.body.connections).toHaveLength(0);

    const revokeB = await json<any>("/api/provider-connections/anthropic/revoke", {
      method: "POST",
      cookies: b.cookies,
    });
    expect(revokeB.status).toBe(404);

    expect(
      (await json("/api/provider-connections/anthropic/api-key", {
        method: "PUT",
        cookies: b.cookies,
        body: { apiKey: keyB, metadata: { email: "b@example.com" } },
      })).status,
    ).toBe(200);

    const [rowA] = await db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.orgId, a.orgId),
          eq(providerConnections.provider, "anthropic"),
        ),
      );
    const [rowB] = await db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.orgId, b.orgId),
          eq(providerConnections.provider, "anthropic"),
        ),
      );
    expect(rowA?.userId).not.toBe(rowB?.userId);
    expect(
      await getTrustedProviderCredential({
        orgId: a.orgId,
        userId: rowA!.userId,
        provider: "anthropic",
        authMethod: "api_key",
      }),
    ).toEqual({ authMethod: "api_key", value: keyA });
    expect(
      await getTrustedProviderCredential({
        orgId: b.orgId,
        userId: rowB!.userId,
        provider: "anthropic",
        authMethod: "api_key",
      }),
    ).toEqual({ authMethod: "api_key", value: keyB });
  });

  test("two users in the same organization cannot read, update, or revoke each other's connection", async () => {
    const owner = await createOrgSession("pc-owner");
    const other = await createOrgSession("pc-other");
    const ownerUserId = await userIdForEmail(owner.email);
    const otherUserId = await userIdForEmail(other.email);
    const ownerKey = `sk-owner-${crypto.randomUUID()}`;
    const otherKey = `sk-other-${crypto.randomUUID()}`;

    await db.insert(member).values({
      id: uid("member"),
      organizationId: owner.orgId,
      userId: otherUserId,
      role: "member",
      createdAt: new Date(),
    });
    const setActive = await fetchApi("/api/auth/organization/set-active", {
      method: "POST",
      cookies: other.cookies,
      body: { organizationId: owner.orgId },
    });
    expect(setActive.status).toBe(200);
    other.jar.absorb(setActive);
    const otherInOwnerOrgCookies = other.jar.header();

    expect(
      (await json("/api/provider-connections/openai/api-key", {
        method: "PUT",
        cookies: owner.cookies,
        body: { apiKey: ownerKey, metadata: { email: "owner@example.com" } },
      })).status,
    ).toBe(200);

    const otherList = await json<any>("/api/provider-connections", { cookies: otherInOwnerOrgCookies });
    expect(otherList.status).toBe(200);
    expect(otherList.body.connections).toHaveLength(0);

    const otherRevoke = await json<any>("/api/provider-connections/openai/revoke", {
      method: "POST",
      cookies: otherInOwnerOrgCookies,
    });
    expect(otherRevoke.status).toBe(404);

    expect(
      (await json("/api/provider-connections/openai/api-key", {
        method: "PUT",
        cookies: otherInOwnerOrgCookies,
        body: { apiKey: otherKey, metadata: { email: "other@example.com" } },
      })).status,
    ).toBe(200);

    expect(
      await getTrustedProviderCredential({
        orgId: owner.orgId,
        userId: ownerUserId,
        provider: "openai",
        authMethod: "api_key",
      }),
    ).toEqual({ authMethod: "api_key", value: ownerKey });
    expect(
      await getTrustedProviderCredential({
        orgId: owner.orgId,
        userId: otherUserId,
        provider: "openai",
        authMethod: "api_key",
      }),
    ).toEqual({ authMethod: "api_key", value: otherKey });
  });

  test("same user can read metadata and revoke hides credential from trusted retrieval", async () => {
    const session = await createOrgSession("pc-revoke");
    const apiKey = `sk-revoke-${crypto.randomUUID()}`;

    await json("/api/provider-connections/openrouter/api-key", {
      method: "PUT",
      cookies: session.cookies,
      body: { apiKey, metadata: { planType: "pro" } },
    });
    const [row] = await db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.orgId, session.orgId),
          eq(providerConnections.provider, "openrouter"),
        ),
      );

    const read = await json<any>("/api/provider-connections/openrouter", { cookies: session.cookies });
    expect(read.status).toBe(200);
    expect(read.body.connection.metadata).toEqual({ planType: "pro" });
    assertNoCredentialMaterial(read.body, apiKey);

    const revoked = await json<any>("/api/provider-connections/openrouter/revoke", { method: "POST", cookies: session.cookies });
    expect(revoked.status).toBe(200);
    expect(revoked.body.connection.status).toBe("revoked");
    expect(revoked.body.connection.revokedAt).toBeTruthy();
    assertNoCredentialMaterial(revoked.body, apiKey);

    expect(
      await getTrustedProviderCredential({
        orgId: session.orgId,
        userId: row!.userId,
        provider: "openrouter",
        authMethod: "api_key",
      }),
    ).toBeNull();
  });

  test("trusted OAuth bundles are service-only and not accepted by browser API", async () => {
    const session = await createOrgSession("pc-oauth");

    const browserAttempt = await json<any>("/api/provider-connections/openai/chatgpt-oauth", {
      method: "PUT",
      cookies: session.cookies,
      body: { accessToken: "browser-token" },
    });
    expect(browserAttempt.status).toBe(404);

    await storeTrustedChatGptOAuthProviderConnection({
      orgId: session.orgId,
      userId: await userIdForEmail(session.email),
      provider: "openai",
      bundle: {
        accessToken: "trusted-access",
        refreshToken: "trusted-refresh",
        expiresAt: "2026-08-16T00:00:00.000Z",
        scope: "openid profile email",
      },
      metadata: { email: "oauth@example.com", planType: "plus" },
    });

    const trusted = await getTrustedProviderCredential({
      orgId: session.orgId,
      userId: await userIdForEmail(session.email),
      provider: "openai",
      authMethod: "chatgpt_oauth",
    });
    expect(trusted).toEqual({
      authMethod: "chatgpt_oauth",
      value: {
        accessToken: "trusted-access",
        refreshToken: "trusted-refresh",
        expiresAt: "2026-08-16T00:00:00.000Z",
        scope: "openid profile email",
      },
    });
  });
});
