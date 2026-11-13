import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";

// OpenID Connect sign-in through the real better-auth routes and database: the
// sign-in request, the provider's redirect back to the callback, the session.
// Only the identity provider is fake, stubbed at `fetch` (discovery and token
// endpoints), so no test reaches the network.
const OIDC = {
  OIDC_ISSUER: "https://idp.example.test/realms/acme",
  OIDC_CLIENT_ID: "useagent-test",
  OIDC_CLIENT_SECRET: "oidc-test-secret",
  OIDC_BUTTON_LABEL: "Acme SSO",
};
const NAMES = [...Object.keys(OIDC), "NODE_ENV", "BETTER_AUTH_SECRET", "SIGNUP_OPEN", "CONNECTOR_EMAIL_HOST", "CONNECTOR_EMAIL_FROM", "SIGNUP_ALLOWED_DOMAINS"];
const prior = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
function restore(names: readonly string[]): void {
  for (const name of names) {
    if (prior[name] === undefined) delete process.env[name];
    else process.env[name] = prior[name];
  }
}

await import("./helpers");
const { createAuthServer, oidcDisplayName } = await import("../src/auth");
const { db } = await import("../src/db/client");
const { account, invitation, member, organization, session, user } = await import("../src/db/auth-schema");
const { env, oidcAuthConfig, providerSignInEnabled } = await import("../src/env");
const { canSignIn } = await import("../src/auth-invitations");

Object.assign(process.env, OIDC);
// Built outside production so the library's own rate limiter (on in production)
// lets this file sign in many times; the sign-up policy reads NODE_ENV per
// request, and each sign-in below runs in production.
process.env.BETTER_AUTH_SECRET = "oidc-auth-test-secret-0123456789abcdef";
const auth = createAuthServer();
restore(["BETTER_AUTH_SECRET"]);

const prefix = `oidc-auth-${crypto.randomUUID().slice(0, 8)}`;
const address = (label: string, domain = "example.test") => `${prefix}-${label}@${domain}`;
/** Where the library sends a browser whose new account the sign-up policy refused. */
const REFUSED = "/api/auth/error?error=Account_creation_is_disabled";
const DISCOVERY = `${OIDC.OIDC_ISSUER}/.well-known/openid-configuration`;
const TOKEN_ENDPOINT = `${OIDC.OIDC_ISSUER}/protocol/openid-connect/token`;

/** What the fake provider says about the person who signs in next. */
let claims: Record<string, unknown> = {};
const tokenRequests: URLSearchParams[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === DISCOVERY) {
    return Response.json({
      issuer: OIDC.OIDC_ISSUER,
      authorization_endpoint: `${OIDC.OIDC_ISSUER}/protocol/openid-connect/auth`,
      token_endpoint: TOKEN_ENDPOINT,
      userinfo_endpoint: `${OIDC.OIDC_ISSUER}/protocol/openid-connect/userinfo`,
    });
  }
  if (url === TOKEN_ENDPOINT) {
    tokenRequests.push(new URLSearchParams(String(init?.body ?? "")));
    return Response.json({ access_token: "access", token_type: "Bearer", expires_in: 300, id_token: idToken(claims) });
  }
  return realFetch(input, init);
}) as typeof fetch;

/** An ID token as the token endpoint returns it over TLS. The library reads its
 *  claims without checking the signature, so this one carries none. */
function idToken(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({ iss: OIDC.OIDC_ISSUER, aud: OIDC.OIDC_CLIENT_ID, ...payload })}.`;
}

function cookieHeader(response: Response, previous = ""): string {
  const jar = new Map(previous.split("; ").filter(Boolean).map((pair) => [pair.split("=")[0], pair] as const));
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0];
    jar.set(pair.split("=")[0], pair);
  }
  return [...jar.values()].join("; ");
}

/** The whole browser round trip: ask to sign in, follow the provider back to
 *  the callback with a code, and report where the callback sends the browser. */
async function signInAs(
  person: Record<string, unknown>,
  extra: Record<string, string> = {},
): Promise<{ status: number; location: string; cookies: string }> {
  claims = person;
  const started = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/oauth2`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.FRONTEND_ORIGIN },
      body: JSON.stringify({ providerId: "oidc", callbackURL: "/", ...extra }),
    }),
  );
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.origin + authorize.pathname).toBe(`${OIDC.OIDC_ISSUER}/protocol/openid-connect/auth`);
  expect(authorize.searchParams.get("client_id")).toBe(OIDC.OIDC_CLIENT_ID);
  expect(authorize.searchParams.get("scope")).toBe("openid email profile");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${env.BETTER_AUTH_URL}/api/auth/oauth2/callback/oidc`);
  const state = authorize.searchParams.get("state") ?? "";
  const cookies = cookieHeader(started);
  const back = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/oauth2/callback/oidc?code=provider-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookies },
    }),
  );
  return { status: back.status, location: back.headers.get("location") ?? "", cookies: cookieHeader(back, cookies) };
}

async function inProduction<T>(work: () => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  process.env.NODE_ENV = "production";
  Object.assign(process.env, extra);
  try {
    return await work();
  } finally {
    restore(["NODE_ENV", ...Object.keys(extra)]);
  }
}

async function usersWith(email: string) {
  return db.select().from(user).where(eq(user.email, email));
}

const inviterId = `user_${crypto.randomUUID()}`;
const orgId = `org_${crypto.randomUUID()}`;
await db.insert(user).values({ id: inviterId, name: prefix, email: address("inviter"), emailVerified: true });
await db.insert(organization).values({ id: orgId, name: prefix, slug: `${prefix}-org`, createdAt: new Date() });
await db.insert(member).values({ id: `member_${crypto.randomUUID()}`, organizationId: orgId, userId: inviterId, role: "owner", createdAt: new Date() });

async function invite(email: string): Promise<void> {
  await db.insert(invitation).values({
    id: `inv_${crypto.randomUUID()}`,
    organizationId: orgId,
    email,
    role: "member",
    status: "pending",
    expiresAt: new Date(Date.now() + 86_400_000),
    inviterId,
  });
}

afterEach(() => {
  tokenRequests.length = 0;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  restore(NAMES);
  await db.delete(user).where(like(user.email, `${prefix}%`));
  await db.delete(organization).where(like(organization.slug, `${prefix}%`));
});

describe("OpenID Connect settings", () => {
  test("all three settings turn it on, with the discovery URL under the issuer and a default label", () => {
    expect(oidcAuthConfig({ OIDC_ISSUER: "https://idp.example.test/realms/acme/", OIDC_CLIENT_ID: "id", OIDC_CLIENT_SECRET: "secret" })).toEqual({
      discoveryUrl: "https://idp.example.test/realms/acme/.well-known/openid-configuration",
      clientId: "id",
      clientSecret: "secret",
      label: "SSO",
    });
    expect(oidcAuthConfig({ OIDC_ISSUER: "http://localhost:8080", OIDC_CLIENT_ID: "id", OIDC_CLIENT_SECRET: "secret", OIDC_BUTTON_LABEL: " Okta " })).toMatchObject({
      discoveryUrl: "http://localhost:8080/.well-known/openid-configuration",
      label: "Okta",
    });
  });

  test("absent, partial or malformed settings leave it off", () => {
    expect(oidcAuthConfig({})).toBeNull();
    expect(oidcAuthConfig({ OIDC_ISSUER: "https://idp.example.test", OIDC_CLIENT_ID: "id" })).toBeNull();
    expect(oidcAuthConfig({ OIDC_CLIENT_ID: "id", OIDC_CLIENT_SECRET: "secret" })).toBeNull();
    expect(oidcAuthConfig({ OIDC_ISSUER: " ", OIDC_CLIENT_ID: "id", OIDC_CLIENT_SECRET: "secret" })).toBeNull();
    for (const issuer of ["idp.example.test", "ftp://idp.example.test", "https://idp.example.test/?realm=a", "https://idp.example.test/#a"]) {
      expect(oidcAuthConfig({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "id", OIDC_CLIENT_SECRET: "secret" })).toBeNull();
    }
  });

  test("the display name falls back from name to given and family names, the username, then the address", () => {
    expect(oidcDisplayName({ name: "Ada Lovelace", preferred_username: "ada" })).toBe("Ada Lovelace");
    expect(oidcDisplayName({ given_name: "Ada", family_name: "Lovelace", preferred_username: "ada" })).toBe("Ada Lovelace");
    expect(oidcDisplayName({ name: " ", preferred_username: "ada", email: "ada@example.test" })).toBe("ada");
    expect(oidcDisplayName({ email: "ada@example.test" })).toBe("ada@example.test");
    expect(oidcDisplayName({})).toBeUndefined();
  });
});

describe("the sign-in card", () => {
  test("provider-config names the button only when OpenID Connect is set up", async () => {
    const { handleAuthRequest } = await import("../src/auth/routes");
    const read = async () => (await (await handleAuthRequest(new Request("http://localhost:3211/api/auth/provider-config"))).json()) as Record<string, unknown>;
    const on = await read();
    expect(on.oidc).toEqual({ label: "Acme SSO" });
    expect(JSON.stringify(on)).not.toContain(OIDC.OIDC_CLIENT_SECRET);
    expect(JSON.stringify(on)).not.toContain(OIDC.OIDC_ISSUER);
    expect(providerSignInEnabled()).toBe(true);

    for (const name of Object.keys(OIDC)) delete process.env[name];
    try {
      expect((await read()).oidc).toBeNull();
    } finally {
      Object.assign(process.env, OIDC);
    }
  });

  test("a server built without the settings has no OpenID Connect routes", async () => {
    for (const name of Object.keys(OIDC)) delete process.env[name];
    let plain: ReturnType<typeof createAuthServer>;
    try {
      plain = createAuthServer();
    } finally {
      Object.assign(process.env, OIDC);
    }
    const response = await plain.handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/oauth2`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: env.FRONTEND_ORIGIN },
        body: JSON.stringify({ providerId: "oidc", callbackURL: "/" }),
      }),
    );
    expect(response.status).toBe(404);
  });
});

describe("new accounts follow the Google rules", () => {
  test("a closed deployment refuses an identity nobody invited, and creates nothing", async () => {
    const email = address("stranger");
    const result = await inProduction(() => signInAs({ sub: "stranger", email, email_verified: true, name: "Stranger" }));
    expect(result.status).toBe(302);
    expect(result.location).toContain(REFUSED);
    expect(result.cookies).not.toContain("session_token");
    expect(await usersWith(email)).toEqual([]);
    // The code was exchanged with the client's own secret and the PKCE verifier.
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.get("code")).toBe("provider-code");
    expect(tokenRequests[0]?.get("code_verifier")?.length).toBeGreaterThan(0);
  });

  test("the web card's error URL brings a refused person back to the login card with the reason", async () => {
    const email = address("refused-to-card");
    const result = await inProduction(() =>
      signInAs({ sub: "refused-to-card", email, email_verified: true, name: "Refused" }, { errorCallbackURL: "/login?via=provider" }),
    );
    expect(result.location).toBe("/login?via=provider&error=Account_creation_is_disabled");
    expect(await usersWith(email)).toEqual([]);
  });

  test("a pending invitation lets a verified identity create its account and sign in", async () => {
    const email = address("invited");
    await invite(email);
    const result = await inProduction(() =>
      signInAs({ sub: "invited", email: email.toUpperCase(), email_verified: true, preferred_username: "invited-person" }),
    );
    expect(result.status).toBe(302);
    expect(result.location).toBe("/");
    expect(result.cookies).toContain("session_token");
    const [created] = await usersWith(email);
    expect(created).toMatchObject({ email, emailVerified: true, name: "invited-person" });
    expect(await db.select({ providerId: account.providerId, accountId: account.accountId }).from(account).where(eq(account.userId, created!.id))).toEqual([
      { providerId: "oidc", accountId: "invited" },
    ]);
    expect(await db.select().from(session).where(eq(session.userId, created!.id))).toHaveLength(1);
    // Every account lands in a workspace of its own.
    expect(await db.select().from(member).where(eq(member.userId, created!.id))).toHaveLength(1);
  });

  test("an invitation does not admit an address the provider did not verify", async () => {
    for (const [label, verified] of [["unverified", false], ["string-verified", "true"], ["missing-verified", undefined]] as const) {
      const email = address(label);
      await invite(email);
      const result = await inProduction(() => signInAs({ sub: label, email, email_verified: verified, name: label }));
      expect(result.location).toContain(REFUSED);
      expect(await usersWith(email)).toEqual([]);
    }
  });

  test("open sign-up admits only its domains, like a Google identity", async () => {
    const open = { SIGNUP_OPEN: "1", CONNECTOR_EMAIL_HOST: "127.0.0.1", CONNECTOR_EMAIL_FROM: "hello@example.test", SIGNUP_ALLOWED_DOMAINS: "example.test" };
    const outside = address("outside", "elsewhere.test");
    const refused = await inProduction(() => signInAs({ sub: "outside", email: outside, email_verified: true, name: "Outside" }), open);
    expect(refused.location).toContain("/api/auth/error?error=Sign-up_is_limited_to_%40example.test_addresses");
    expect(await usersWith(outside)).toEqual([]);

    const inside = address("inside");
    const admitted = await inProduction(() => signInAs({ sub: "inside", email: inside, email_verified: true, name: "Inside" }), open);
    expect(admitted.location).toBe("/");
    expect(await usersWith(inside)).toHaveLength(1);
  });
});

describe("existing accounts", () => {
  test("a verified identity links an existing account and signs it in; an unverified one does not", async () => {
    const email = address("existing");
    const id = `user_${crypto.randomUUID()}`;
    await db.insert(user).values({ id, name: "Existing", email, emailVerified: true });

    const refused = await inProduction(() => signInAs({ sub: "existing-unverified", email, email_verified: false, name: "Existing" }));
    expect(refused.location).toContain("error=account_not_linked");
    expect(await db.select().from(account).where(eq(account.userId, id))).toEqual([]);
    expect(await db.select().from(session).where(eq(session.userId, id))).toEqual([]);

    const linked = await inProduction(() => signInAs({ sub: "existing", email, email_verified: true, name: "Existing" }));
    expect(linked.location).toBe("/");
    expect(await db.select({ providerId: account.providerId }).from(account).where(eq(account.userId, id))).toEqual([{ providerId: "oidc" }]);
    expect(await db.select().from(session).where(eq(session.userId, id))).toHaveLength(1);
  });

  test("an invitation to an address without a password can be used once OpenID Connect is on", async () => {
    await inProduction(async () => {
      expect(await canSignIn(address("nobody-yet"))).toBe(true);
      for (const name of Object.keys(OIDC)) delete process.env[name];
      try {
        expect(await canSignIn(address("nobody-yet"))).toBe(false);
      } finally {
        Object.assign(process.env, OIDC);
      }
    });
  });
});
