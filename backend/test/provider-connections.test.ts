import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../src/db/client";
import { member, providerConnections, user } from "../src/db/schema";
import type { AppEnv } from "../src/http";
import { resolveCodexSubscriptionRuntime } from "../src/engines/runtime-provider-bridge";
import {
  cancelCodexChatGptAppServerLogin,
  codexAppServerChildEnvironment,
  CodexAppServerAuthError,
  completeCodexChatGptAppServerLogin,
  handleManagedCodexChatGptLoginCompleted,
  isCodexAppServerAccountMethod,
  readCodexChatGptAppServerStatus,
  readManagedCodexChatGptStatus,
  refreshCodexChatGptAppServerTokens,
  revokeManagedCodexChatGptLogin,
  startCodexChatGptAppServerLogin,
  type CodexAppServerClient,
  type CodexAppServerLoginStartResult,
  type CodexChatGptStatus,
  type ManagedCodexAppServerClient,
} from "../src/provider-connections/codex-app-server";
import { createProviderConnectionsRoutes, type CodexChatGptOAuthLifecycle } from "../src/provider-connections/routes";
import {
  getCurrentUserProviderConnection,
  getCodexSubscriptionRuntimeSelection,
  getTrustedCodexSubscriptionAuth,
  getTrustedProviderCredential,
  storeManagedCodexAppServerProviderConnection,
  storeTrustedChatGptOAuthProviderConnection,
  type ProviderConnectionMeta,
} from "../src/provider-connections/service";
import { subscribeOrg } from "../src/runs/org-signals";
import { BASE, ORIGIN, createOrgSession, fetchApi, json, uid } from "./helpers";

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

  async function customJson<T = unknown>(
    app: Hono<AppEnv>,
    path: string,
    init: { method?: string; body?: unknown; cookies?: string } = {},
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { origin: ORIGIN };
    let body: BodyInit | undefined;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["content-type"] = "application/json";
    }
    if (init.cookies) headers.cookie = init.cookies;
    const response = await app.fetch(new Request(BASE + path, {
      method: init.method ?? "GET",
      headers,
      body,
    }));
    return {
      status: response.status,
      body: await response.json() as T,
    };
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
  }, 10_000);

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
    expect(otherRevoke.status).toBe(400);
    expect(otherRevoke.body).toEqual({ error: "authMethod is required for openai revoke" });

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
        accountId: "account-trusted",
        planType: "plus",
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
        accountId: "account-trusted",
        planType: "plus",
        refreshToken: "trusted-refresh",
        expiresAt: "2026-08-16T00:00:00.000Z",
        scope: "openid profile email",
      },
    });
  });

  test("Codex app-server login starts with ChatGPT tokens only inside the trusted server bridge", async () => {
    const session = await createOrgSession("pc-codex-login");
    const userId = await userIdForEmail(session.email);
    const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    const appServer: CodexAppServerClient = {
      request: async (method, params) => {
        calls.push({ method, params });
        return { type: "chatgptAuthTokens" };
      },
    };

    await storeTrustedChatGptOAuthProviderConnection({
      orgId: session.orgId,
      userId,
      provider: "openai",
      bundle: {
        accessToken: "trusted-access",
        accountId: "account-trusted",
        planType: "plus",
        refreshToken: "trusted-refresh",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      metadata: { email: "oauth@example.com", planType: "plus" },
    });

    const summary = await startCodexChatGptAppServerLogin({
      appServer,
      scope: { orgId: session.orgId, userId },
    });

    expect(calls).toEqual([
      {
        method: "account/login/start",
        params: {
          type: "chatgptAuthTokens",
          accessToken: "trusted-access",
          chatgptAccountId: "account-trusted",
          chatgptPlanType: "plus",
        },
      },
    ]);
    expect(summary).toEqual({
      status: "started",
      accountId: "account-trusted",
      planType: "plus",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assertNoCredentialMaterial(summary, "trusted-refresh");
    expect(JSON.stringify(summary)).not.toContain("trusted-access");
  });

  test("Codex app-server token refresh is org/user scoped and never returns refresh tokens", async () => {
    const session = await createOrgSession("pc-codex-refresh");
    const userId = await userIdForEmail(session.email);
    await storeTrustedChatGptOAuthProviderConnection({
      orgId: session.orgId,
      userId,
      provider: "openai",
      bundle: {
        accessToken: "fresh-access",
        accountId: "account-refresh",
        planType: "team",
        refreshToken: "server-refresh",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      metadata: { planType: "team" },
    });

    const refreshed = await refreshCodexChatGptAppServerTokens({
      scope: { orgId: session.orgId, userId },
      request: { reason: "unauthorized", previousAccountId: "account-refresh" },
    });

    expect(refreshed).toEqual({
      accessToken: "fresh-access",
      chatgptAccountId: "account-refresh",
      chatgptPlanType: "team",
    });
    expect(JSON.stringify(refreshed)).not.toContain("server-refresh");
    await expect(
      refreshCodexChatGptAppServerTokens({
        scope: { orgId: session.orgId, userId },
        request: { reason: "unauthorized", previousAccountId: "other-account" },
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerAuthError",
      code: "account_mismatch",
    } satisfies Partial<CodexAppServerAuthError>);
  });

  test("Codex app-server token handoff fails closed for missing or expired trusted auth", async () => {
    const session = await createOrgSession("pc-codex-expired");
    const userId = await userIdForEmail(session.email);
    await storeTrustedChatGptOAuthProviderConnection({
      orgId: session.orgId,
      userId,
      provider: "openai",
      bundle: {
        accessToken: "expired-access",
        accountId: "account-expired",
        planType: "plus",
        refreshToken: "server-refresh",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
      metadata: {},
    });

    await expect(
      refreshCodexChatGptAppServerTokens({
        scope: { orgId: session.orgId, userId },
        request: { reason: "unauthorized" },
        nowMs: Date.parse("2026-08-16T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerAuthError",
      code: "reauth_required",
    } satisfies Partial<CodexAppServerAuthError>);
    await expect(
      refreshCodexChatGptAppServerTokens({
        scope: { orgId: session.orgId, userId: "missing-user" },
        request: { reason: "unauthorized" },
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerAuthError",
      code: "reauth_required",
    } satisfies Partial<CodexAppServerAuthError>);
  });

  test("Codex app-server cancel, status, and completion handlers stay metadata-only", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    const appServer: CodexAppServerClient = {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "account/login/cancel") return { status: "cancelled" };
        return {
          account: {
            authMode: "chatgptAuthTokens",
            planType: "plus",
            email: "managed@example.com",
            accessToken: "should-not-return",
          },
          requiresOpenaiAuth: false,
        };
      },
    };

    await expect(
      cancelCodexChatGptAppServerLogin({ appServer, loginId: "login-1" }),
    ).resolves.toEqual({ status: "cancelled" });
    await expect(readCodexChatGptAppServerStatus(appServer)).resolves.toEqual({
      account: {
        authMode: "chatgptAuthTokens",
        email: "managed@example.com",
        planType: "plus",
      },
      requiresOpenaiAuth: false,
    });
    expect(completeCodexChatGptAppServerLogin({
      loginId: "login-1",
      success: true,
      error: null,
    })).toEqual({
      status: "completed",
      loginId: "login-1",
      success: true,
      error: null,
    });
    expect(calls).toEqual([
      { method: "account/login/cancel", params: { loginId: "login-1" } },
      { method: "account/read", params: { refreshToken: false } },
    ]);
    expect(JSON.stringify(calls)).not.toContain("should-not-return");
  });

  test("managed Codex app-server sessions persist encrypted metadata and expose runtime selection only to backend", async () => {
    const session = await createOrgSession("pc-managed-runtime");
    const userId = await userIdForEmail(session.email);

    const connection = await storeManagedCodexAppServerProviderConnection({
      orgId: session.orgId,
      userId,
      session: {
        type: "managed_codex_app_server",
        codexHome: "/srv/skynet/codex-home/user-a",
        email: "managed@example.com",
        planType: "plus",
        connectedAt: "2026-08-16T00:00:00.000Z",
      },
      metadata: { email: "managed@example.com", planType: "plus" },
    });
    expect(connection.authMethod).toBe("chatgpt_oauth");

    expect(
      await getTrustedCodexSubscriptionAuth({
        orgId: session.orgId,
        userId,
      }),
    ).toBeNull();
    await expect(resolveCodexSubscriptionRuntime({ orgId: session.orgId })).resolves.toBeNull();
    await expect(resolveCodexSubscriptionRuntime({ userId })).resolves.toBeNull();
    await expect(resolveCodexSubscriptionRuntime({ orgId: session.orgId, userId })).resolves.toMatchObject({
      connectionId: connection.id,
      authEpoch: expect.stringMatching(/^[a-f0-9]{64}$/),
      authMethod: "chatgpt_oauth",
      mode: "managed_codex_app_server",
      codexHome: "/srv/skynet/codex-home/user-a",
      metadata: { email: "managed@example.com", planType: "plus" },
    });
    await expect(
      getCodexSubscriptionRuntimeSelection({
        orgId: session.orgId,
        userId: "wrong-user",
      }),
    ).resolves.toBeNull();
    await expect(
      getCodexSubscriptionRuntimeSelection({
        orgId: "wrong-org",
        userId,
      }),
    ).resolves.toBeNull();
    await expect(resolveCodexSubscriptionRuntime({ orgId: "wrong-org", userId })).resolves.toBeNull();
  });

  test("managed Codex login completion consumes app-server notification and persists connected account metadata", async () => {
    const session = await createOrgSession("pc-managed-complete");
    const userId = await userIdForEmail(session.email);
    const appServer: ManagedCodexAppServerClient = {
      codexHome: "/srv/skynet/codex-home/completed-user",
      close: () => undefined,
      onNotification: () => () => undefined,
      request: async (method) => {
        expect(method).toBe("account/read");
        return {
          account: {
            type: "chatgpt",
            email: "complete@example.com",
            planType: "team",
          },
          requiresOpenaiAuth: false,
        };
      },
    };

    const connection = await handleManagedCodexChatGptLoginCompleted({
      scope: { orgId: session.orgId, userId },
      appServer,
      notification: {
        loginId: "login-complete",
        success: true,
        error: null,
      },
    });

    expect(connection).toMatchObject({
      provider: "openai",
      authMethod: "chatgpt_oauth",
      status: "connected",
      metadata: { email: "complete@example.com", planType: "team" },
    });
    await expect(resolveCodexSubscriptionRuntime({ orgId: session.orgId, userId })).resolves.toMatchObject({
      connectionId: connection.id,
      authEpoch: expect.stringMatching(/^[a-f0-9]{64}$/),
      authMethod: "chatgpt_oauth",
      mode: "managed_codex_app_server",
      codexHome: "/srv/skynet/codex-home/completed-user",
      metadata: { email: "complete@example.com", planType: "team" },
    });
  });

  test("managed Codex status reads do not republish an unchanged connection", async () => {
    const session = await createOrgSession("pc-managed-status-idempotent");
    const userId = await userIdForEmail(session.email);
    const changes: string[] = [];
    const unsubscribe = subscribeOrg(session.orgId, (change) => {
      if (change.type === "provider_connection") changes.push(change.action);
    });
    const appServer: ManagedCodexAppServerClient = {
      codexHome: "/srv/skynet/codex-home/status-user",
      close: () => undefined,
      onNotification: () => () => undefined,
      request: async (method) => {
        expect(method).toBe("account/read");
        return {
          account: {
            type: "chatgpt",
            email: "status@example.com",
            planType: "pro",
          },
          requiresOpenaiAuth: false,
        };
      },
    };

    try {
      await readManagedCodexChatGptStatus({
        scope: { orgId: session.orgId, userId },
        appServer,
      });
      const [before] = await db
        .select()
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.orgId, session.orgId),
            eq(providerConnections.userId, userId),
            eq(providerConnections.provider, "openai"),
            eq(providerConnections.authMethod, "chatgpt_oauth"),
          ),
        );

      await readManagedCodexChatGptStatus({
        scope: { orgId: session.orgId, userId },
        appServer,
      });
      const [after] = await db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, before!.id));

      expect(changes).toEqual(["updated"]);
      expect(after!.updatedAt).toEqual(before!.updatedAt);
    } finally {
      unsubscribe();
    }
  });

  test("managed Codex reconnect preserves its timestamp until the connected account changes", async () => {
    const session = await createOrgSession("pc-managed-reconnect");
    const userId = await userIdForEmail(session.email);
    const scope = { orgId: session.orgId, userId };
    const codexHome = "/srv/skynet/codex-home/reconnected-user";
    const connectedAt = "2026-08-15T00:00:00.000Z";
    let account = {
      type: "chatgpt",
      email: "original@example.com",
      planType: "plus",
    };
    const appServer: ManagedCodexAppServerClient = {
      codexHome,
      close: () => undefined,
      onNotification: () => () => undefined,
      request: async (method) => {
        expect(method).toBe("account/read");
        return { account, requiresOpenaiAuth: false };
      },
    };

    await storeManagedCodexAppServerProviderConnection({
      ...scope,
      session: {
        type: "managed_codex_app_server",
        codexHome,
        email: account.email,
        planType: account.planType,
        connectedAt,
      },
      metadata: { email: account.email, planType: account.planType },
    });
    const originalRuntime = await getCodexSubscriptionRuntimeSelection(scope);
    expect(originalRuntime?.authEpoch).toMatch(/^[a-f0-9]{64}$/);

    await readManagedCodexChatGptStatus({ scope, appServer });
    await expect(getCodexSubscriptionRuntimeSelection(scope)).resolves.toMatchObject({
      authEpoch: originalRuntime?.authEpoch,
    });
    await expect(
      getTrustedProviderCredential({
        ...scope,
        provider: "openai",
        authMethod: "chatgpt_oauth",
      }),
    ).resolves.toEqual({
      authMethod: "chatgpt_oauth",
      value: {
        type: "managed_codex_app_server",
        codexHome,
        email: "original@example.com",
        planType: "plus",
        connectedAt,
      },
    });

    account = {
      type: "chatgpt",
      email: "replacement@example.com",
      planType: "pro",
    };
    await readManagedCodexChatGptStatus({ scope, appServer });
    const credential = await getTrustedProviderCredential({
      ...scope,
      provider: "openai",
      authMethod: "chatgpt_oauth",
    });
    expect(credential).toMatchObject({
      authMethod: "chatgpt_oauth",
      value: {
        type: "managed_codex_app_server",
        codexHome,
        email: "replacement@example.com",
        planType: "pro",
      },
    });
    if (
      !credential ||
      credential.authMethod !== "chatgpt_oauth" ||
      typeof credential.value === "string" ||
      !("type" in credential.value) ||
      credential.value.type !== "managed_codex_app_server"
    ) {
      throw new Error("expected a managed Codex app-server credential");
    }
    expect(credential.value.connectedAt).not.toBe(connectedAt);
    const replacementRuntime = await getCodexSubscriptionRuntimeSelection(scope);
    expect(replacementRuntime).toMatchObject({
      metadata: { email: "replacement@example.com", planType: "pro" },
    });
    expect(replacementRuntime?.authEpoch).not.toBe(originalRuntime?.authEpoch);
  });

  test("concurrent initial managed Codex status reads persist and publish once", async () => {
    const session = await createOrgSession("pc-managed-status-concurrent");
    const userId = await userIdForEmail(session.email);
    const scope = { orgId: session.orgId, userId };
    const changes: string[] = [];
    const unsubscribe = subscribeOrg(session.orgId, (change) => {
      if (change.type === "provider_connection") changes.push(change.action);
    });
    const bothReadsStarted = Promise.withResolvers<void>();
    let readCount = 0;
    const appServer: ManagedCodexAppServerClient = {
      codexHome: "/srv/skynet/codex-home/concurrent-status-user",
      close: () => undefined,
      onNotification: () => () => undefined,
      request: async (method) => {
        expect(method).toBe("account/read");
        readCount += 1;
        if (readCount === 2) bothReadsStarted.resolve();
        await bothReadsStarted.promise;
        return {
          account: {
            type: "chatgpt",
            email: "concurrent@example.com",
            planType: "team",
          },
          requiresOpenaiAuth: false,
        };
      },
    };

    try {
      await Promise.all([
        readManagedCodexChatGptStatus({ scope, appServer }),
        readManagedCodexChatGptStatus({ scope, appServer }),
      ]);

      expect(changes).toEqual(["updated"]);
      const rows = await db
        .select()
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.orgId, session.orgId),
            eq(providerConnections.userId, userId),
            eq(providerConnections.provider, "openai"),
            eq(providerConnections.authMethod, "chatgpt_oauth"),
          ),
        );
      expect(rows).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  test("concurrent managed Codex status reads cannot reconnect after logout, but a fresh login can", async () => {
    const session = await createOrgSession("pc-managed-status-revoke-race");
    const userId = await userIdForEmail(session.email);
    const scope = { orgId: session.orgId, userId };
    const codexHome = "/srv/skynet/codex-home/revoke-race-user";

    await storeManagedCodexAppServerProviderConnection({
      ...scope,
      session: {
        type: "managed_codex_app_server",
        codexHome,
        email: "before-logout@example.com",
        planType: "plus",
        connectedAt: "2026-08-16T00:00:00.000Z",
      },
      metadata: { email: "before-logout@example.com", planType: "plus" },
    });

    const bothReadsStarted = Promise.withResolvers<void>();
    const releaseReads = Promise.withResolvers<void>();
    let readCount = 0;
    const staleStatusAppServer: ManagedCodexAppServerClient = {
      codexHome,
      close: () => undefined,
      onNotification: () => () => undefined,
      request: async (method) => {
        expect(method).toBe("account/read");
        readCount += 1;
        if (readCount === 2) bothReadsStarted.resolve();
        await releaseReads.promise;
        return {
          account: {
            type: "chatgpt",
            email: "before-logout@example.com",
            planType: "plus",
          },
          requiresOpenaiAuth: false,
        };
      },
    };
    const statusReads = [
      readManagedCodexChatGptStatus({ scope, appServer: staleStatusAppServer }),
      readManagedCodexChatGptStatus({ scope, appServer: staleStatusAppServer }),
    ];
    await bothReadsStarted.promise;

    const logoutAppServer: ManagedCodexAppServerClient = {
      codexHome,
      close: () => undefined,
      onNotification: () => () => undefined,
      request: async (method) => {
        expect(method).toBe("account/logout");
        return {};
      },
    };
    await expect(
      revokeManagedCodexChatGptLogin({ scope, appServer: logoutAppServer }),
    ).resolves.toMatchObject({ status: "revoked" });

    releaseReads.resolve();
    await Promise.all(statusReads);
    await expect(
      getCurrentUserProviderConnection({
        ...scope,
        provider: "openai",
        authMethod: "chatgpt_oauth",
      }),
    ).resolves.toMatchObject({ status: "revoked" });
    await expect(
      getTrustedProviderCredential({
        ...scope,
        provider: "openai",
        authMethod: "chatgpt_oauth",
      }),
    ).resolves.toBeNull();

    const freshLoginAppServer: ManagedCodexAppServerClient = {
      codexHome,
      close: () => undefined,
      onNotification: () => () => undefined,
      request: async (method) => {
        expect(method).toBe("account/read");
        return {
          account: {
            type: "chatgpt",
            email: "after-login@example.com",
            planType: "pro",
          },
          requiresOpenaiAuth: false,
        };
      },
    };
    await expect(
      handleManagedCodexChatGptLoginCompleted({
        scope,
        appServer: freshLoginAppServer,
        notification: { loginId: "fresh-login", success: true, error: null },
      }),
    ).resolves.toMatchObject({
      status: "connected",
      metadata: { email: "after-login@example.com", planType: "pro" },
    });
  });

  test("managed Codex app-server is an account-only broker with a minimal child environment", () => {
    expect(isCodexAppServerAccountMethod("account/login/start")).toBe(true);
    expect(isCodexAppServerAccountMethod("account/read")).toBe(true);
    expect(isCodexAppServerAccountMethod("account/logout")).toBe(true);
    expect(isCodexAppServerAccountMethod("thread/start")).toBe(false);
    expect(isCodexAppServerAccountMethod("turn/start")).toBe(false);

    const childEnv = codexAppServerChildEnvironment("/srv/skynet/codex-home/auth-only", {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp/skynet",
      DATABASE_URL: "postgres://backend-secret",
      OPENAI_API_KEY: "backend-openai-secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/google.json",
    });
    expect(childEnv).toEqual({
      CODEX_HOME: "/srv/skynet/codex-home/auth-only",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    });
  });

  test("revoking managed Codex login closes the client so it cannot remain cached", async () => {
    const session = await createOrgSession("pc-managed-revoke");
    const userId = await userIdForEmail(session.email);
    let closeCalls = 0;
    const appServer: ManagedCodexAppServerClient = {
      codexHome: "/srv/skynet/codex-home/revoked-user",
      close: () => {
        closeCalls += 1;
      },
      onNotification: () => () => undefined,
      request: async (method) => {
        expect(method).toBe("account/logout");
        return {};
      },
    };

    await storeManagedCodexAppServerProviderConnection({
      orgId: session.orgId,
      userId,
      session: {
        type: "managed_codex_app_server",
        codexHome: appServer.codexHome,
        connectedAt: "2026-08-16T00:00:00.000Z",
      },
      metadata: {},
    });

    await expect(
      revokeManagedCodexChatGptLogin({
        scope: { orgId: session.orgId, userId },
        appServer,
      }),
    ).resolves.toMatchObject({ status: "revoked" });
    expect(closeCalls).toBe(1);
  });

  test("managed Codex revocation fails closed when host logout fails", async () => {
    const session = await createOrgSession("pc-managed-revoke-failure");
    const userId = await userIdForEmail(session.email);
    let closeCalls = 0;
    const appServer: ManagedCodexAppServerClient = {
      codexHome: "/srv/skynet/codex-home/revoke-failure-user",
      close: () => {
        closeCalls += 1;
      },
      onNotification: () => () => undefined,
      request: async (method) => {
        expect(method).toBe("account/logout");
        throw new CodexAppServerAuthError("app_server_rejected");
      },
    };

    await storeManagedCodexAppServerProviderConnection({
      orgId: session.orgId,
      userId,
      session: {
        type: "managed_codex_app_server",
        codexHome: appServer.codexHome,
        connectedAt: "2026-08-16T00:00:00.000Z",
      },
      metadata: {},
    });

    await expect(
      revokeManagedCodexChatGptLogin({
        scope: { orgId: session.orgId, userId },
        appServer,
      }),
    ).rejects.toMatchObject({ code: "app_server_rejected" });
    expect(closeCalls).toBe(1);

    const connection = await getCurrentUserProviderConnection({
      orgId: session.orgId,
      userId,
      provider: "openai",
      authMethod: "chatgpt_oauth",
    });
    expect(connection?.status).toBe("connected");
  });

  test("ChatGPT OAuth lifecycle routes expose only login/status metadata and bind calls to authenticated org user", async () => {
    const session = await createOrgSession("pc-managed-routes");
    const userId = await userIdForEmail(session.email);
    const calls: Array<{ action: string; scope: { orgId: string; userId: string }; loginId?: string }> = [];
    const lifecycle: CodexChatGptOAuthLifecycle = {
      start: async ({ scope, loginMethod }) => {
        calls.push({ action: `start:${loginMethod}`, scope });
        return {
          type: "chatgptDeviceCode",
          loginId: "login-safe",
          verificationUrl: "https://auth.openai.com/activate",
          userCode: "ABCD-EFGH",
        } satisfies CodexAppServerLoginStartResult;
      },
      status: async ({ scope }) => {
        calls.push({ action: "status", scope });
        return {
          account: {
            authMode: "chatgpt",
            email: "managed@example.com",
            planType: "plus",
          },
          requiresOpenaiAuth: false,
        } satisfies CodexChatGptStatus;
      },
      cancel: async ({ scope, loginId }) => {
        calls.push({ action: "cancel", scope, loginId });
        return { status: "cancelled" };
      },
      revoke: async ({ scope }) => {
        calls.push({ action: "revoke", scope });
        return {
          id: "connection-safe",
          provider: "openai",
          authMethod: "chatgpt_oauth",
          status: "revoked",
          metadata: { email: "managed@example.com", planType: "plus" },
          createdAt: "2026-08-16T00:00:00.000Z",
          updatedAt: "2026-08-16T00:00:00.000Z",
          revokedAt: "2026-08-16T00:00:00.000Z",
        } satisfies ProviderConnectionMeta;
      },
    };
    const app = new Hono<AppEnv>().route(
      "/api/provider-connections",
      createProviderConnectionsRoutes({ codexChatGptOAuth: lifecycle }),
    );

    const start = await customJson<{ login: CodexAppServerLoginStartResult }>(
      app,
      "/api/provider-connections/openai/chatgpt-oauth/start",
      {
        method: "POST",
        cookies: session.cookies,
        body: { loginMethod: "chatgpt", accessToken: "must-ignore" },
      },
    );
    expect(start.status).toBe(200);
    expect(start.body).toEqual({
      login: {
        type: "chatgptDeviceCode",
        loginId: "login-safe",
        verificationUrl: "https://auth.openai.com/activate",
        userCode: "ABCD-EFGH",
      },
    });

    const status = await customJson<{ status: CodexChatGptStatus }>(
      app,
      "/api/provider-connections/openai/chatgpt-oauth/status",
      { cookies: session.cookies },
    );
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      status: {
        account: {
          authMode: "chatgpt",
          email: "managed@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: false,
      },
    });

    const cancel = await customJson<{ status: "cancelled" }>(
      app,
      "/api/provider-connections/openai/chatgpt-oauth/cancel",
      {
        method: "POST",
        cookies: session.cookies,
        body: { loginId: "login-safe", refreshToken: "must-ignore" },
      },
    );
    expect(cancel.status).toBe(200);
    expect(cancel.body).toEqual({ status: "cancelled" });

    const revoke = await customJson<{ connection: ProviderConnectionMeta }>(
      app,
      "/api/provider-connections/openai/chatgpt-oauth/revoke",
      { method: "POST", cookies: session.cookies },
    );
    expect(revoke.status).toBe(200);
    expect(revoke.body.connection.status).toBe("revoked");

    const ambiguousGenericRevoke = await customJson<{ error: string }>(
      app,
      "/api/provider-connections/openai/revoke",
      { method: "POST", cookies: session.cookies },
    );
    expect(ambiguousGenericRevoke).toEqual({
      status: 400,
      body: { error: "authMethod is required for openai revoke" },
    });

    const genericRevoke = await customJson<{ connection: ProviderConnectionMeta }>(
      app,
      "/api/provider-connections/openai/revoke?authMethod=chatgpt_oauth",
      { method: "POST", cookies: session.cookies },
    );
    expect(genericRevoke.status).toBe(200);
    expect(genericRevoke.body.connection.status).toBe("revoked");

    const expectedScope = { orgId: session.orgId, userId };
    expect(calls).toEqual([
      { action: "start:device_code", scope: expectedScope },
      { action: "status", scope: expectedScope },
      { action: "cancel", scope: expectedScope, loginId: "login-safe" },
      { action: "revoke", scope: expectedScope },
      { action: "revoke", scope: expectedScope },
    ]);
    const serialized = JSON.stringify({
      start,
      status,
      cancel,
      revoke,
      ambiguousGenericRevoke,
      genericRevoke,
      calls,
    });
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("codexHome");
  });
});
