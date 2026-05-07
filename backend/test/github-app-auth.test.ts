import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  clearInstallationTokenCache,
  getInstallationToken,
} from "../src/github/app-auth";
import { githubAppConfig, githubAuthSource, githubConfigured } from "../src/env";

// A throwaway RSA key so we can both feed the App path a real private key AND
// verify the JWT it signs — no network, fully deterministic.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const realFetch = globalThis.fetch;

interface MockOpts {
  installations?: unknown;
  insStatus?: number;
  tokStatus?: number;
  token?: string;
  expiresAt?: string;
}

/** Intercept fetch: capture the App JWT sent to /app/installations, canned mint. */
function installFetchMock(opts: MockOpts = {}) {
  const fn = mock(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    if (u.endsWith("/app/installations")) {
      lastJwt = auth.replace(/^Bearer /, "");
      return new Response(JSON.stringify(opts.installations ?? DEFAULT_INSTALLS), {
        status: opts.insStatus ?? 200,
      });
    }
    if (u.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({
          token: opts.token ?? "ghs_installtoken",
          expires_at: opts.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: opts.tokStatus ?? 201 },
      );
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const DEFAULT_INSTALLS = [
  { id: 42, account: { login: "upstream-org" } },
  { id: 7, account: { login: "SomeoneElse" } },
];

let lastJwt: string | null = null;

/** RS256-verify a JWT against the public key and return its decoded payload. */
function verifyAndDecode(jwt: string): Record<string, unknown> {
  const [h, p, s] = jwt.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  verifier.end();
  const ok = verifier.verify(publicKey, Buffer.from(s, "base64url"));
  expect(ok).toBe(true);
  return JSON.parse(Buffer.from(p, "base64url").toString());
}

beforeEach(() => {
  process.env.GITHUB_APP_ID = "123456";
  process.env.GITHUB_APP_PRIVATE_KEY = PEM;
  process.env.GITHUB_ORG = "upstream-org";
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_PAT;
  lastJwt = null;
  clearInstallationTokenCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_ORG"]) {
    delete process.env[k];
  }
});

describe("github app config + precedence", () => {
  test("app config parses; source is 'app' with no PAT, 'pat' with one", () => {
    expect(githubConfigured()).toBe(true);
    expect(githubAuthSource()).toBe("app");
    const cfg = githubAppConfig();
    expect(cfg?.appId).toBe("123456");
    expect(cfg?.org).toBe("upstream-org");

    process.env.GITHUB_TOKEN = "ghp_pat";
    expect(githubAuthSource()).toBe("pat"); // PAT wins over the App
    delete process.env.GITHUB_TOKEN;
  });

  test("partial app config (id without key) → disabled", () => {
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    expect(githubAppConfig()).toBeNull();
    expect(githubAuthSource()).toBe("anon");
  });
});

describe("installation token mint", () => {
  test("signs a verifiable RS256 App JWT and mints a token", async () => {
    installFetchMock();
    const { token, expiresAt } = await getInstallationToken();
    expect(token).toBe("ghs_installtoken");
    expect(expiresAt).toBeGreaterThan(Date.now());

    const payload = verifyAndDecode(lastJwt as string);
    expect(payload.iss).toBe("123456");
    expect((payload.exp as number) - (payload.iat as number)).toBeGreaterThan(0);
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(10 * 60);
  });

  test("picks the org's installation when several exist", async () => {
    const fn = installFetchMock();
    await getInstallationToken();
    const mintCall = fn.mock.calls.find((c) => String(c[0]).includes("/access_tokens"));
    expect(String(mintCall?.[0])).toContain("/app/installations/42/access_tokens");
  });

  test("caches within TTL — a second call does not re-mint", async () => {
    const fn = installFetchMock({ expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    await getInstallationToken();
    const after1 = fn.mock.calls.length;
    await getInstallationToken();
    expect(fn.mock.calls.length).toBe(after1); // served from cache
  });

  test("re-mints when the cached token is near expiry", async () => {
    const fn = installFetchMock({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await getInstallationToken();
    const after1 = fn.mock.calls.length;
    await getInstallationToken();
    expect(fn.mock.calls.length).toBeGreaterThan(after1); // refreshed
  });
});

describe("honest failures", () => {
  test("401 on installations → descriptive error naming the creds", async () => {
    installFetchMock({ insStatus: 401 });
    await expect(getInstallationToken()).rejects.toThrow(/401.*GITHUB_APP_ID/s);
  });

  test("no installations → tells you to install the App", async () => {
    installFetchMock({ installations: [] });
    await expect(getInstallationToken()).rejects.toThrow(/no installations/i);
  });

  test("org not among installations → names what IS installed", async () => {
    installFetchMock({ installations: [{ id: 9, account: { login: "OtherOrg" } }] });
    await expect(getInstallationToken()).rejects.toThrow(/not installed on org "upstream-org".*OtherOrg/s);
  });
});
