import { describe, expect, test } from "bun:test";
import { createOpenConnectorBackend, normalizeOpenConnectorOrigin } from "./open-connector";

describe("OpenConnector backend", () => {
  test("accepts only HTTPS origins outside local loopback development", () => {
    expect(normalizeOpenConnectorOrigin("https://connect.example.com/")).toBe(
      "https://connect.example.com",
    );
    expect(() => normalizeOpenConnectorOrigin("http://connect.example.com")).toThrow(
      "requires HTTPS",
    );
    expect(() => normalizeOpenConnectorOrigin("https://user:pass@connect.example.com")).toThrow(
      "without credentials",
    );
    expect(() => normalizeOpenConnectorOrigin("https://connect.example.com/api")).toThrow(
      "without credentials",
    );
    expect(normalizeOpenConnectorOrigin("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
  });

  test("uses separate admin/runtime credentials and never emits them in results", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/api/oauth/authorizations")) {
        return Response.json({ authorizationUrl: "https://linear.app/oauth/authorize" });
      }
      if (String(url).includes("/v1/actions?service=linear")) {
        return Response.json({ data: [{ id: "linear.list_issues", description: "List issues", inputSchema: {} }] });
      }
      return Response.json([]);
    }) as typeof fetch;
    const backend = createOpenConnectorBackend(
      {
        origin: "https://connect.example.com",
        adminToken: "admin-secret",
        runtimeToken: "runtime-secret",
      },
      fetchImpl,
    );

    const started = await backend.startConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "linear",
      state: "state-1",
    });
    expect(started.redirectUrl).toBe("https://linear.app/oauth/authorize");
    expect(JSON.stringify(started)).not.toContain("secret");

    await backend.listActions({
      orgId: "org-1",
      userId: "user-1",
      connection: {
        id: "connection-1",
        orgId: "org-1",
        ownerType: "user",
        ownerUserId: "user-1",
        provider: "linear",
        runtimeBindingId: backend.runtimeBindingId,
        externalConnectionId: "external-1",
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
      },
    });

    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer admin-secret");
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe("Bearer runtime-secret");
    expect(calls.every((call) => call.init.signal instanceof AbortSignal)).toBe(true);
  });

  test("advertises OAuth providers only after their runtime client is configured", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      expect(String(url)).toEndWith("/api/oauth/configs");
      return Response.json([
        { service: "linear", configured: true },
        { service: "gmail", configured: false },
        { service: "github", configured: true },
      ]);
    }) as typeof fetch;
    const backend = createOpenConnectorBackend(
      {
        origin: "https://connect.example.com",
        adminToken: "admin-secret",
        runtimeToken: "runtime-secret",
      },
      fetchImpl,
    );

    expect(await backend.listConnectableProviders()).toEqual(["linear"]);
  });
});
