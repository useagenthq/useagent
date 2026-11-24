import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  completeIntegrationConnect,
  disconnectIntegration,
  fetchIntegrations,
  startIntegrationConnect,
} from "./integrations-api";

interface FetchCall {
  input: RequestInfo | URL;
  init?: RequestInit;
}

const originalFetch = globalThis.fetch;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
let calls: FetchCall[] = [];
let responses: Response[] = [];

beforeEach(() => {
  calls = [];
  responses = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (!response) throw new Error("missing mocked response");
    return response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

const connection = {
  id: "conn-1",
  provider: "linear",
  owner: { type: "user", userId: "user-1" },
  status: "connected",
  account: { displayName: "Ada" },
  scopes: ["read"],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  lastVerifiedAt: null,
  revokedAt: null,
};

describe("fetchIntegrations", () => {
  test("reads the integrations list without caching and decodes it", async () => {
    responses.push(
      Response.json({
        integrations: [
          {
            provider: "github",
            displayName: "GitHub",
            description: "Native repository workflows.",
            backend: "native",
            authMethod: "custom_credential",
            managed: true,
            configured: true,
            status: "connected",
            degradationReason: null,
            permissions: { scopes: [], actionCount: 0, effects: [], approvals: [] },
            connection: null,
          },
        ],
      }),
    );

    const integrations = await fetchIntegrations();

    expect(calls[0]?.input).toBe("/api/integrations");
    expect(calls[0]?.init?.cache).toBe("no-store");
    expect(integrations).toHaveLength(1);
    expect(integrations[0]).toMatchObject({ provider: "github", displayName: "GitHub" });
  });

  test("throws when the backend refuses", async () => {
    responses.push(new Response(null, { status: 500 }));

    await expect(fetchIntegrations()).rejects.toThrow("integrations 500");
  });
});

describe("startIntegrationConnect", () => {
  test("uses the org path for GitHub and Slack", async () => {
    for (const provider of ["github", "slack"]) {
      responses.push(Response.json({ redirectUrl: "https://example.test/auth", state: "s-1" }));
      await startIntegrationConnect(provider);
    }

    expect(calls.map((call) => call.input)).toEqual([
      "/api/integrations/github/connect/org",
      "/api/integrations/slack/connect/org",
    ]);
  });

  test("uses the user path for other apps and encodes the provider", async () => {
    responses.push(
      Response.json({ redirectUrl: "https://example.test/auth", state: "s-1" }),
      Response.json({ redirectUrl: "https://example.test/auth", state: "s-2" }),
    );

    await startIntegrationConnect("linear");
    await startIntegrationConnect("my app");

    expect(calls.map((call) => call.input)).toEqual([
      "/api/integrations/linear/connect",
      "/api/integrations/my%20app/connect",
    ]);
  });

  test("posts the settings return path and returns the connect start", async () => {
    responses.push(
      Response.json({
        redirectUrl: "https://example.test/auth",
        state: "s-1",
        expiresAt: "2026-11-07T12:00:00.000Z",
      }),
    );

    const start = await startIntegrationConnect("linear");

    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ returnTo: "/settings#integrations" }));
    expect(start).toEqual({
      redirectUrl: "https://example.test/auth",
      state: "s-1",
      expiresAt: "2026-11-07T12:00:00.000Z",
    });
  });

  test("reports no expiry when the backend omits one", async () => {
    responses.push(Response.json({ redirectUrl: "https://example.test/auth", state: "s-1" }));

    const start = await startIntegrationConnect("linear");

    expect(start.expiresAt).toBeNull();
  });

  test("throws when the backend refuses", async () => {
    responses.push(new Response(null, { status: 502 }));

    await expect(startIntegrationConnect("linear")).rejects.toThrow("integration-connect 502");
  });

  test("throws when the redirect URL or state is missing or blank", async () => {
    const payloads = [
      { state: "s-1" },
      { redirectUrl: "  ", state: "s-1" },
      { redirectUrl: "https://example.test/auth" },
      { redirectUrl: "https://example.test/auth", state: "" },
    ];
    for (const payload of payloads) {
      responses.push(Response.json(payload));
      await expect(startIntegrationConnect("linear")).rejects.toThrow(
        "integration-connect missing redirectUrl",
      );
    }
  });
});

describe("completeIntegrationConnect", () => {
  test("posts the state and callback and returns the connection", async () => {
    responses.push(Response.json({ connection }));

    const result = await completeIntegrationConnect("s-1", { code: "abc" });

    expect(calls[0]?.input).toBe("/api/integrations/callback");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ state: "s-1", callback: { code: "abc" } }));
    expect(result).toMatchObject({ id: "conn-1", provider: "linear", status: "connected" });
  });

  test("leaves the callback out when there is none", async () => {
    responses.push(Response.json({ connection }));

    await completeIntegrationConnect("s-1");

    expect(calls[0]?.init?.body).toBe(JSON.stringify({ state: "s-1" }));
  });

  test("returns null while the authorization is still pending", async () => {
    responses.push(new Response(null, { status: 400 }), new Response(null, { status: 409 }));

    expect(await completeIntegrationConnect("s-1")).toBeNull();
    expect(await completeIntegrationConnect("s-1")).toBeNull();
  });

  test("throws on other errors", async () => {
    responses.push(new Response(null, { status: 500 }));

    await expect(completeIntegrationConnect("s-1")).rejects.toThrow("integration-callback 500");
  });

  test("throws when the answer has no usable connection", async () => {
    responses.push(Response.json({}), Response.json({ connection: { id: "conn-1" } }));

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(completeIntegrationConnect("s-1")).rejects.toThrow(
        "integration-callback missing connection",
      );
    }
  });
});

describe("disconnectIntegration", () => {
  test("deletes on the org path for GitHub and Slack and the user path for other apps", async () => {
    responses.push(
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    );

    await disconnectIntegration("github", "conn-1");
    await disconnectIntegration("slack", "conn-2");
    await disconnectIntegration("linear", "conn/3");

    expect(calls.map((call) => call.input)).toEqual([
      "/api/integrations/github/org?connectionId=conn-1",
      "/api/integrations/slack/org?connectionId=conn-2",
      "/api/integrations/linear?connectionId=conn%2F3",
    ]);
    expect(calls.every((call) => call.init?.method === "DELETE")).toBe(true);
  });

  test("throws when the backend refuses", async () => {
    responses.push(new Response(null, { status: 404 }));

    await expect(disconnectIntegration("linear", "conn-1")).rejects.toThrow(
      "integration-disconnect 404",
    );
  });
});
