import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { IntegrationConnectionRecord } from "./connection-repo";
import {
  createOomolProjectConnectorBackend,
  normalizeOomolConnectorOrigin,
  oomolExternalUserId,
  oomolProjectConnectorConfigFromEnv,
} from "./oomol-project-connector";

function connection(provider = "gmail"): IntegrationConnectionRecord {
  return {
    id: "connection-1",
    orgId: "org-1",
    ownerType: "user",
    ownerUserId: "user-1",
    provider,
    runtimeBindingId: "oomol-project:project-1",
    externalConnectionId: "ca-1",
    externalConnectionName: "work",
    status: "connected",
    authMethod: "oauth2",
    accountMetadata: {},
    scopes: [],
    createdByUserId: "user-1",
    lastVerifiedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function backend(fetchImpl: typeof fetch) {
  return createOomolProjectConnectorBackend(
    {
      origin: "https://connector.oomol.com/v1",
      projectId: "project-1",
      projectApiKey: "oo_proj_secret",
      catalogApiKey: "api_catalog_secret",
      returnUri: "https://useagent.example/api/integrations/oomol/callback",
      providerConfigIds: { gmail: "pc-gmail" },
    },
    fetchImpl,
  );
}

describe("OOMOL ProjectConnector backend", () => {
  test("enables project service mode without provider config overrides", () => {
    const names = [
      "OOMOL_PROJECT_API_KEY",
      "OOMOL_PROJECT_ID",
      "OOMOL_CONNECT_RETURN_URI",
      "OOMOL_PROJECT_PROVIDER_CONFIGS",
      "OOMOL_CONNECTOR_BASE_URL",
      "OOMOL_API_KEY",
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      process.env.OOMOL_PROJECT_API_KEY = "oo_proj_test_key";
      process.env.OOMOL_PROJECT_ID = "project-1";
      process.env.OOMOL_CONNECT_RETURN_URI =
        "https://useagent.example/api/integrations/oomol/callback";
      delete process.env.OOMOL_PROJECT_PROVIDER_CONFIGS;
      delete process.env.OOMOL_CONNECTOR_BASE_URL;
      delete process.env.OOMOL_API_KEY;

      expect(oomolProjectConnectorConfigFromEnv()).toEqual({
        origin: "https://connector.oomol.com/v1",
        projectId: "project-1",
        projectApiKey: "oo_proj_test_key",
        returnUri: "https://useagent.example/api/integrations/oomol/callback",
      });

      process.env.OOMOL_PROJECT_PROVIDER_CONFIGS = '{"gmail":"pc-gmail"}';
      expect(oomolProjectConnectorConfigFromEnv()?.providerConfigIds).toEqual({
        gmail: "pc-gmail",
      });
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("normalizes only HTTPS hosted origins and local development HTTP", () => {
    expect(normalizeOomolConnectorOrigin("https://connector.oomol.com")).toBe(
      "https://connector.oomol.com/v1",
    );
    expect(normalizeOomolConnectorOrigin("https://connector.oomol.com/v1/")).toBe(
      "https://connector.oomol.com/v1",
    );
    expect(normalizeOomolConnectorOrigin("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000/v1",
    );
    expect(() => normalizeOomolConnectorOrigin("http://connector.oomol.com")).toThrow(
      "requires HTTPS",
    );
    expect(() => normalizeOomolConnectorOrigin("https://connector.oomol.com/admin")).toThrow(
      "must be an origin or end in /v1",
    );
  });

  test("isolates the same user id across organizations without exposing either identifier", () => {
    const first = oomolExternalUserId({ orgId: "org-a", userId: "user-1" });
    const second = oomolExternalUserId({ orgId: "org-b", userId: "user-1" });
    expect(first).not.toBe(second);
    expect(first).not.toContain("org-a");
    expect(first).not.toContain("user-1");
    expect(oomolExternalUserId({ orgId: "org-1", userId: "user-1" })).toBe(
      `ua_${createHash("sha256").update("org-1\0user-1").digest("hex")}`,
    );
  });

  test("creates and completes OAuth using explicit provider config and tenant binding", async () => {
    const calls: Array<{ url: string; init: RequestInit; body?: Record<string, unknown> }> = [];
    const externalUserId = oomolExternalUserId({ orgId: "org-1", userId: "user-1" });
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), init: init ?? {}, body });
      if (String(url).endsWith("/saas/connected-accounts/link")) {
        return Response.json({
          success: true,
          data: {
            id: "request-1",
            status: "initiated",
            projectId: "project-1",
            providerConfigId: "pc-gmail",
            externalUserId,
            service: "gmail",
            alias: "work",
            authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
      }
      return Response.json({
        success: true,
        data: {
          id: "request-1",
          status: "connected",
          projectId: "project-1",
          providerConfigId: "pc-gmail",
          externalUserId,
          service: "gmail",
          alias: "work",
          connectedAccountId: "ca-1",
        },
      });
    }) as typeof fetch;
    const connector = backend(fetchImpl);

    const started = await connector.startConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "gmail",
      state: "useagent-state",
    });
    expect(started.backendSessionRef).toBe("request-1");
    expect(calls[0]?.body).toMatchObject({
      providerConfigId: "pc-gmail",
      userId: externalUserId,
      returnUri: "https://useagent.example/api/integrations/oomol/callback?state=useagent-state",
    });
    expect(JSON.stringify(started)).not.toContain("oo_proj_secret");

    const completed = await connector.completeConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "gmail",
      backendSessionRef: started.backendSessionRef,
    });
    expect(completed.externalConnectionId).toBe("ca-1");
    expect(completed.account).toEqual({ externalAccountId: "ca-1" });
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer oo_proj_secret");
    expect(calls.every((call) => call.init.signal instanceof AbortSignal)).toBe(true);
  });

  test("rejects a completed request that belongs to another tenant", async () => {
    const fetchImpl = (async () => Response.json({
      success: true,
      data: {
        status: "connected",
        projectId: "project-1",
        providerConfigId: "pc-gmail",
        externalUserId: oomolExternalUserId({ orgId: "other-org", userId: "user-1" }),
        service: "gmail",
        connectedAccountId: "ca-other",
      },
    })) as unknown as typeof fetch;

    await expect(backend(fetchImpl).completeConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "gmail",
      backendSessionRef: "request-1",
    })).rejects.toThrow("wrong tenant or provider");
  });

  test("rejects OAuth start and completion records from another project", async () => {
    const externalUserId = oomolExternalUserId({ orgId: "org-1", userId: "user-1" });
    const startFetch = (async () => Response.json({
      success: true,
      data: {
        id: "request-1",
        status: "initiated",
        projectId: "project-other",
        providerConfigId: "pc-gmail",
        externalUserId,
        service: "gmail",
        authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })) as unknown as typeof fetch;
    await expect(backend(startFetch).startConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "gmail",
      state: "useagent-state",
    })).rejects.toThrow("wrong tenant or provider");

    const completeFetch = (async () => Response.json({
      success: true,
      data: {
        status: "connected",
        projectId: "project-other",
        providerConfigId: "pc-gmail",
        externalUserId,
        service: "gmail",
        connectedAccountId: "ca-other",
      },
    })) as unknown as typeof fetch;
    await expect(backend(completeFetch).completeConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "gmail",
      backendSessionRef: "request-1",
    })).rejects.toThrow("wrong tenant or provider");
  });

  test("executes a pre-existing user-owned connection with its legacy creator identity", async () => {
    const calls: Array<{ url: string; init: RequestInit; body?: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), init: init ?? {}, body });
      if (String(url).includes("/actions?service=gmail")) {
        return Response.json({
          success: true,
          data: [{
            id: "gmail.send_email",
            service: "gmail",
            name: "Send email",
            description: "Send an email",
            inputSchema: { type: "object" },
          }],
        });
      }
      return Response.json({
        success: true,
        data: { executionId: "exec-1", actionId: "gmail.send_email", output: { sent: true } },
      });
    }) as typeof fetch;
    const connector = backend(fetchImpl);
    const storedConnection = connection();

    const actions = await connector.listActions({
      orgId: "org-1",
      userId: "user-1",
      connection: storedConnection,
    });
    expect(actions[0]).toMatchObject({
      provider: "gmail",
      actionId: "gmail.send_email",
      publicName: "Send email",
      inputSchema: { type: "object" },
    });

    const result = await connector.executeAction({
      orgId: "org-1",
      userId: "user-1",
      connection: storedConnection,
      actionId: "gmail.send_email",
      input: { to: "user@example.com" },
      idempotencyKey: "request-123",
    });
    expect(result).toEqual({ sent: true });
    expect(calls[1]?.body).toEqual({
      providerConfigId: "pc-gmail",
      userId: oomolExternalUserId({ orgId: "org-1", userId: "user-1" }),
      connectedAccountId: "ca-1",
      input: { to: "user@example.com" },
    });
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer api_catalog_secret",
    );
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe(
      "Bearer oo_proj_secret",
    );
  });

  test("executes a pre-existing org-owned connection with its legacy creator identity", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const externalUserId = oomolExternalUserId({
      orgId: "org-1",
      userId: "admin-1",
    });
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).endsWith("/saas/connected-accounts/link")) {
        return Response.json({
          success: true,
          data: {
            id: "request-1",
            status: "initiated",
            projectId: "project-1",
            providerConfigId: "pc-project-default",
            externalUserId,
            service: "gmail",
            authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
      }
      if (String(url).includes("/saas/connection-requests/")) {
        return Response.json({
          success: true,
          data: {
            id: "request-1",
            status: "connected",
            projectId: "project-1",
            providerConfigId: "pc-project-default",
            externalUserId,
            service: "gmail",
            connectedAccountId: "ca-1",
          },
        });
      }
      if (String(url).includes("/profile")) {
        return Response.json({ message: "profile unavailable" }, { status: 404 });
      }
      return Response.json({
        success: true,
        data: { executionId: "exec-1", actionId: "gmail.send_email", output: { sent: true } },
      });
    }) as typeof fetch;
    const connector = createOomolProjectConnectorBackend({
      origin: "https://connector.oomol.com/v1",
      projectId: "project-1",
      projectApiKey: "oo_proj_secret",
      returnUri: "https://useagent.example/api/integrations/oomol/callback",
    }, fetchImpl);

    expect(await connector.listConnectableProviders()).toEqual([
      "linear",
      "gmail",
      "notion",
      "hubspot",
    ]);
    expect(connector.supports("github")).toBe(false);
    expect(connector.supports("slack")).toBe(false);

    const started = await connector.startConnect({
      orgId: "org-1",
      userId: "admin-1",
      provider: "gmail",
      state: "useagent-state",
    });
    const completed = await connector.completeConnect({
      orgId: "org-1",
      userId: "admin-1",
      provider: "gmail",
      backendSessionRef: started.backendSessionRef,
    });
    const result = await connector.executeAction({
      orgId: "org-1",
      userId: "member-2",
      connection: {
        ...connection(),
        ownerType: "org",
        ownerUserId: null,
        createdByUserId: "admin-1",
      },
      actionId: "gmail.send_email",
      input: { to: "user@example.com" },
      idempotencyKey: "request-123",
    });

    expect(completed.externalConnectionId).toBe("ca-1");
    expect(result).toEqual({ sent: true });
    expect(calls[0]?.body).toMatchObject({ service: "gmail", userId: externalUserId });
    expect(calls[0]?.body).not.toHaveProperty("providerConfigId");
    const execution = calls.find((call) => call.url.includes("/saas/actions/"));
    expect(execution?.body).toEqual({
      service: "gmail",
      userId: externalUserId,
      connectedAccountId: "ca-1",
      input: { to: "user@example.com" },
    });
  });

  test("rejects a completed service-mode request for another service", async () => {
    const fetchImpl = (async () => Response.json({
      success: true,
      data: {
        status: "connected",
        projectId: "project-1",
        providerConfigId: "pc-project-default",
        externalUserId: oomolExternalUserId({ orgId: "org-1", userId: "user-1" }),
        service: "notion",
        connectedAccountId: "ca-other",
      },
    })) as unknown as typeof fetch;
    const connector = createOomolProjectConnectorBackend({
      origin: "https://connector.oomol.com/v1",
      projectId: "project-1",
      projectApiKey: "oo_proj_secret",
      returnUri: "https://useagent.example/api/integrations/oomol/callback",
    }, fetchImpl);

    await expect(connector.completeConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "gmail",
      backendSessionRef: "request-1",
    })).rejects.toThrow("wrong tenant or provider");
  });

  test("rejects a completed request that does not match its provider config override", async () => {
    const fetchImpl = (async () => Response.json({
      success: true,
      data: {
        status: "connected",
        projectId: "project-1",
        providerConfigId: "pc-other",
        externalUserId: oomolExternalUserId({ orgId: "org-1", userId: "user-1" }),
        service: "gmail",
        connectedAccountId: "ca-other",
      },
    })) as unknown as typeof fetch;

    await expect(backend(fetchImpl).completeConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "gmail",
      backendSessionRef: "request-1",
    })).rejects.toThrow("wrong tenant or provider");
  });

  test("reports that project auth alone cannot read the hosted action catalog", async () => {
    const connector = createOomolProjectConnectorBackend({
      origin: "https://connector.oomol.com/v1",
      projectId: "project-1",
      projectApiKey: "oo_proj_secret",
      returnUri: "https://useagent.example/api/integrations/oomol/callback",
      providerConfigIds: { gmail: "pc-gmail" },
    });

    await expect(connector.listActions({
      orgId: "org-1",
      userId: "user-1",
      connection: connection(),
    })).rejects.toThrow("project auth does not expose catalog APIs");
  });
});
