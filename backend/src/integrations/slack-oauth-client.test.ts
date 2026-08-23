import { describe, expect, test } from "bun:test";
import {
  createSlackOAuthClient,
  type SlackOAuthCredentialBundle,
} from "./slack-oauth-client";

const STATE = "JDr2cFo8GuNU59orXv3vVw0EY1pnppYh9xiKclYoctU";

function json(status: number, body: unknown, headers?: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function client(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  return createSlackOAuthClient(
    {
      appId: "A0BRZ0W1WBX",
      clientId: "11887663854129.11883030064405",
      clientSecret: "client-secret-for-tests",
      redirectUri: "https://useagent.example/api/integrations/slack/callback",
      botScopes: ["chat:write", "channels:read", "chat:write"],
      userScopes: ["search:read"],
      authorizeUrl: "https://slack.example/oauth/v2/authorize",
      apiBaseUrl: "https://slack.example/api",
    },
    { fetch: fetchImpl, now: () => Date.parse("2026-08-23T00:00:00.000Z") },
  );
}

function oauthResponse() {
  return {
    ok: true,
    app_id: "A0BRZ0W1WBX",
    access_token: "xoxb-bot-secret",
    refresh_token: "xoxe-bot-refresh-secret",
    expires_in: 43_200,
    token_type: "bot",
    scope: "chat:write,channels:read",
    bot_user_id: "U0BOT",
    is_enterprise_install: false,
    team: { id: "T0TEAM", name: "Acme Workspace" },
    enterprise: { id: "E0ORG", name: "Acme Grid" },
    authed_user: {
      id: "U0HUMAN",
      access_token: "xoxp-user-secret",
      token_type: "user",
      scope: "search:read",
    },
  };
}

describe("Slack OAuth client", () => {
  test("builds a bounded OAuth v2 authorization URL with state and HTTPS callback", () => {
    const instance = client(async () => json(500, {}));
    const url = new URL(instance.buildAuthorizeUrl({ state: STATE, teamId: "T0TEAM" }));
    expect(url.origin + url.pathname).toBe("https://slack.example/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("11887663854129.11883030064405");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://useagent.example/api/integrations/slack/callback",
    );
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("scope")).toBe("channels:read,chat:write");
    expect(url.searchParams.get("user_scope")).toBe("search:read");
    expect(url.searchParams.get("team")).toBe("T0TEAM");
  });

  test("rejects non-HTTPS callback configuration", () => {
    expect(() =>
      createSlackOAuthClient({
        appId: "A1",
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "http://localhost/callback",
        botScopes: ["chat:write"],
      }),
    ).toThrow("redirect URI must use HTTPS");
  });

  test("rejects callback state mismatch before contacting Slack", async () => {
    let calls = 0;
    const instance = client(async () => {
      calls += 1;
      return json(500, {});
    });
    await expect(
      instance.completeCallback({
        expectedState: STATE,
        callback: { state: `${STATE}x`, code: "oauth-code" },
      }),
    ).rejects.toThrow("state mismatch");
    expect(calls).toBe(0);
  });

  test("uses Basic client authentication and separates encrypted material from safe projection", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const instance = client(async (input, init = {}) => {
      request = { url: String(input), init };
      return json(200, oauthResponse());
    });
    const grant = await instance.completeCallback({
      expectedState: STATE,
      callback: { state: STATE, code: "temporary-code" },
    });

    expect(request?.url).toBe("https://slack.example/api/oauth.v2.access");
    expect(request?.init.method).toBe("POST");
    expect(new Headers(request?.init.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("11887663854129.11883030064405:client-secret-for-tests").toString("base64")}`,
    );
    expect(request?.init.signal).toBeInstanceOf(AbortSignal);
    expect(String(request?.init.body)).toBe(
      "code=temporary-code&redirect_uri=https%3A%2F%2Fuseagent.example%2Fapi%2Fintegrations%2Fslack%2Fcallback",
    );
    expect(grant.credential).toEqual({
      version: 1,
      bot: {
        accessToken: "xoxb-bot-secret",
        refreshToken: "xoxe-bot-refresh-secret",
        tokenType: "bot",
        expiresAt: "2026-08-23T12:00:00.000Z",
      },
      user: {
        id: "U0HUMAN",
        accessToken: "xoxp-user-secret",
        tokenType: "user",
      },
    });
    expect(grant.projection).toEqual({
      externalConnectionId: "T0TEAM",
      externalConnectionName: "Acme Workspace",
      account: { externalAccountId: "T0TEAM", displayName: "Acme Workspace" },
      scopes: ["bot:channels:read", "bot:chat:write", "user:search:read"],
      metadata: {
        appId: "A0BRZ0W1WBX",
        botUserId: "U0BOT",
        authorizedUserId: "U0HUMAN",
        isEnterpriseInstall: false,
        workspace: { id: "T0TEAM", name: "Acme Workspace" },
        enterprise: { id: "E0ORG", name: "Acme Grid" },
      },
    });
    expect(JSON.stringify(grant.projection)).not.toContain("secret");
  });

  test("bounds response bodies and never includes provider payload secrets in errors", async () => {
    const oversized = client(async () =>
      new Response("x".repeat(64 * 1024 + 1), { status: 200 }),
    );
    await expect(
      oversized.completeCallback({
        expectedState: STATE,
        callback: { state: STATE, code: "temporary-code" },
      }),
    ).rejects.toThrow("size limit");

    const secret = "must-not-leak";
    const failed = client(async () => json(200, { ok: false, error: secret, token: secret }));
    const error = await failed
      .completeCallback({
        expectedState: STATE,
        callback: { state: STATE, code: "temporary-code" },
      })
      .catch((caught: unknown) => caught);
    expect(String(error)).toBe("Error: Slack OAuth exchange failed: unknown_error");
    expect(String(error)).not.toContain(secret);
  });

  test("revokes bot and user tokens without putting credentials in the URL", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const instance = client(async (input, init = {}) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init.headers).get("Authorization"),
      });
      return json(200, { ok: true, revoked: true });
    });
    const credential: SlackOAuthCredentialBundle = {
      version: 1,
      bot: { accessToken: "xoxb-bot-secret", tokenType: "bot" },
      user: { id: "U0HUMAN", accessToken: "xoxp-user-secret", tokenType: "user" },
    };
    await instance.revokeCredential(credential);
    expect(calls).toEqual([
      {
        url: "https://slack.example/api/auth.revoke",
        authorization: "Bearer xoxb-bot-secret",
      },
      {
        url: "https://slack.example/api/auth.revoke",
        authorization: "Bearer xoxp-user-secret",
      },
    ]);
    expect(calls.every((call) => !call.url.includes("secret"))).toBe(true);
  });

  test("treats Slack's already-revoked response as idempotent success", async () => {
    const instance = client(async () => json(200, { ok: false, error: "token_revoked" }));
    await expect(instance.revokeToken("xoxb-already-revoked")).resolves.toBeUndefined();
  });
});
