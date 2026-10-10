import { describe, expect, test } from "bun:test";
import type { BrowserWindow } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { desktopContentPolicy, planeManifest } from "../security";
import { createDesktopSignIn, type DesktopAuthClient } from "../sign-in";
import { deepLinkToken, startMockPlane, verifyPkce, type PlaneAuthorization } from "./mock-plane";

function pkcePair(): { codeChallenge: string; codeVerifier: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = Buffer.from(createHash("sha256").update(codeVerifier).digest()).toString("base64url");
  return { codeChallenge, codeVerifier };
}

function responseHeaders(response: Response): Record<string, readonly string[]> {
  const headers: Record<string, readonly string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = [value];
  });
  return headers;
}

/** The desktop content policy reads headers as the shell's webRequest hands them over. */
function policyVerdict(response: Response, packaged = true): { block: boolean; policy: string } {
  return desktopContentPolicy("mainFrame", response.status, responseHeaders(response), packaged);
}

describe("the mock control plane", () => {
  test("answers the manifest, login, session, and organization endpoints in the shape the shell expects", async () => {
    const plane = await startMockPlane();
    try {
      const manifest = await fetch(`${plane.origin}/api/config`);
      expect(manifest.status).toBe(200);
      expect(planeManifest(await manifest.json())).toEqual({
        image: "ghcr.io/useagent/local-sandbox@sha256:9060298717e1b1a6687586e6a0e57c8b8d6e4e2c8a9b0f1d3e5c7a9b8d6e4e2c",
      });

      const login = await fetch(`${plane.origin}/login`);
      expect(login.status).toBe(200);
      // The shell blocks mainFrame HTML without a script nonce, so the login page must carry one.
      const verdict = policyVerdict(login);
      expect(verdict.block).toBe(false);
      expect(verdict.policy).toContain("script-src 'nonce-");
      const nonce = /'nonce-([A-Za-z0-9+/_-]{16,256}={0,2})'/.exec(verdict.policy)?.[1];
      const body = await login.text();
      expect(nonce).toBeDefined();
      expect(body).toContain(`<script nonce="${nonce}">`);
      expect(body).toContain("<h1>Sign in to UseAgent</h1>");

      const workspace = await fetch(`${plane.origin}/`);
      expect(policyVerdict(workspace).block).toBe(false);

      const signedOut = await fetch(`${plane.origin}/api/auth/get-session`);
      expect(signedOut.status).toBe(200);
      expect(await signedOut.json()).toBeNull();

      const organizations = await fetch(`${plane.origin}/api/auth/organization/list`);
      expect(organizations.status).toBe(401);

      expect(plane.exchanged).toBe(false);
    } finally {
      await plane.close();
    }
  });

  test("captures the browser sign-in request and completes the PKCE exchange only with a matching verifier", async () => {
    const plane = await startMockPlane();
    try {
      const pair = pkcePair();
      const state = randomBytes(12).toString("hex").slice(0, 16);
      const request = await fetch(
        `${plane.origin}/desktop-auth?client_id=electron&state=${state}&code_challenge=${pair.codeChallenge}&code_challenge_method=S256`,
      );
      expect(request.status).toBe(200);
      expect(plane.authorizations).toHaveLength(1);
      expect(plane.authorizations[0]!.state).toBe(state);
      expect(plane.authorizations[0]!.codeChallenge).toBe(pair.codeChallenge);

      const wrong = await fetch(`${plane.origin}/api/auth/electron/token`, {
        method: "POST",
        headers: { "electron-origin": "useagent:/", "content-type": "application/json" },
        body: JSON.stringify({ token: plane.authorizations[0]!.identifier, state, code_verifier: randomBytes(32).toString("base64url") }),
      });
      expect(wrong.status).toBe(400);
      expect(plane.exchanged).toBe(false);

      const exchange = await fetch(`${plane.origin}/api/auth/electron/token`, {
        method: "POST",
        headers: { "electron-origin": "useagent:/", "content-type": "application/json" },
        body: JSON.stringify({ token: plane.authorizations[0]!.identifier, state, code_verifier: pair.codeVerifier }),
      });
      expect(exchange.status).toBe(200);
      expect(exchange.headers.get("set-cookie")).toContain("better-auth.session_token=");
      expect(plane.exchanged).toBe(true);
      const session = await exchange.json();
      expect(session.user.id).toBe("user-smoke");

      const authenticated = await fetch(`${plane.origin}/api/auth/get-session`, {
        headers: { cookie: `better-auth.session_token=${(session as { token: string }).token}` },
      });
      const sessionBody = (await authenticated.json()) as { session: { activeOrganizationId: string } };
      expect(sessionBody.session.activeOrganizationId).toBe("org-smoke");

      const membership = await fetch(`${plane.origin}/api/auth/organization/list`, {
        headers: { cookie: `better-auth.session_token=${(session as { token: string }).token}` },
      });
      expect(await membership.json()).toEqual([{ id: "org-smoke", name: "Smoke Workspace" }]);
    } finally {
      await plane.close();
    }
  });

  test("rejects the token exchange from a request that did not come from the native app", async () => {
    const plane = await startMockPlane();
    try {
      const refused = await fetch(`${plane.origin}/api/auth/electron/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "smoke-authorization-x", state: "abcdefghijklmnop", code_verifier: "x".repeat(43) }),
      });
      expect(refused.status).toBe(403);
      expect(plane.exchanged).toBe(false);
    } finally {
      await plane.close();
    }
  });

  test("the deep link token passes the desktop sign-in callback validation and decodes to the plane request", async () => {
    const authorization: PlaneAuthorization = {
      state: "abcdefghijklmnop",
      codeChallenge: "a".repeat(43),
      identifier: "smoke-authorization-0123456789abcdef",
    };
    const token = deepLinkToken(authorization);
    expect(token).toMatch(/^[A-Za-z0-9_-]+={0,2}$/);
    expect(JSON.parse(Buffer.from(token, "base64url").toString())).toEqual({
      state: "abcdefghijklmnop",
      identifier: "smoke-authorization-0123456789abcdef",
    });

    const delivered: string[] = [];
    const loaded: string[] = [];
    const window = {
      webContents: { session: { cookies: { set: async () => undefined } } },
      loadURL: async (url: string) => {
        loaded.push(url);
      },
      show() {},
      focus() {},
    } as unknown as BrowserWindow;
    const activeOrganizationId = "org-smoke";
    const client: DesktopAuthClient = {
      requestAuth: async () => undefined,
      authenticate: async ({ token: value }: { token: string }) => {
        delivered.push(value);
        return { error: null };
      },
      getCookie: () => "better-auth.session_token=app-session",
      getSession: async () => ({ data: { session: { activeOrganizationId } }, error: null }),
      organization: {
        list: async () => ({ data: [{ id: "org-smoke", name: "Smoke Workspace" }], error: null }),
        setActive: async () => ({ error: null }),
      },
    };
    const signIn = createDesktopSignIn(new URL("http://127.0.0.1:1"), window, client, async () => undefined);
    await expect(signIn.complete(`useagent://auth/callback#token=${token}`)).resolves.toBeUndefined();
    expect(delivered).toEqual([token]);
    expect(loaded).toEqual(["http://127.0.0.1:1/"]);
  });
});

describe("verifyPkce", () => {
  test("accepts the verifier whose SHA-256 digest matches the captured challenge", () => {
    const pair = pkcePair();
    expect(verifyPkce(pair.codeChallenge, pair.codeVerifier)).toBe(true);
    expect(verifyPkce(pair.codeChallenge, randomBytes(32).toString("base64url"))).toBe(false);
    expect(verifyPkce(pair.codeChallenge, "short")).toBe(false);
  });

  test("accepts the padded encodings the desktop client actually sends", () => {
    const codeVerifier = `${randomBytes(32).toString("base64url")}=`;
    const codeChallenge = `${Buffer.from(createHash("sha256").update(codeVerifier).digest()).toString("base64url")}=`;
    expect(verifyPkce(codeChallenge, codeVerifier)).toBe(true);
  });
});
