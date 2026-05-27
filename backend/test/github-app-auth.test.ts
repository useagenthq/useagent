import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  clearInstallationTokenCache,
  getInstallationToken,
  getRepositoryInstallationToken,
} from "../src/github/app-auth";
import { resolveGithubSandboxToken } from "../src/github/auth";
import { githubAppConfig, githubAuthSource, githubConfigured } from "../src/env";

// A throwaway RSA key so we can both feed the App path a real private key AND
// verify the JWT it signs — no network, fully deterministic.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const realFetch = globalThis.fetch;

interface MockOpts {
  installations?: unknown;
  repositoryInstallationId?: number;
  repositoryInstallationStatus?: number;
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
    if (/\/repos\/[^/]+\/[^/]+\/installation$/u.test(u)) {
      lastJwt = auth.replace(/^Bearer /, "");
      return new Response(
        JSON.stringify({ id: opts.repositoryInstallationId ?? 42 }),
        { status: opts.repositoryInstallationStatus ?? 200 },
      );
    }
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

async function withProductionMode<T>(
  devMode: "true" | "false",
  action: () => Promise<T>,
): Promise<T> {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorDevMode = process.env.SKYNET_DEV_MODE;
  const priorTenantOrgId = process.env.GITHUB_TENANT_ORG_ID;
  process.env.NODE_ENV = "production";
  process.env.SKYNET_DEV_MODE = devMode;
  process.env.GITHUB_TENANT_ORG_ID = "org-loop";
  try {
    return await action();
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (priorDevMode === undefined) delete process.env.SKYNET_DEV_MODE;
    else process.env.SKYNET_DEV_MODE = priorDevMode;
    if (priorTenantOrgId === undefined) delete process.env.GITHUB_TENANT_ORG_ID;
    else process.env.GITHUB_TENANT_ORG_ID = priorTenantOrgId;
  }
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
  for (const k of [
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_ORG",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_PAT",
    "GITHUB_TENANT_ORG_ID",
  ]) {
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

describe("repository-scoped installation token mint", () => {
  test("restricts the token to the exact repository and read-only clone permissions", async () => {
    const fn = installFetchMock({ token: "ghs_repo_read_only" });

    const result = await getRepositoryInstallationToken("upstream-org/widget");

    expect(result.token).toBe("ghs_repo_read_only");
    const lookup = fn.mock.calls.find((call) =>
      String(call[0]).endsWith("/repos/upstream-org/widget/installation")
    );
    expect(lookup).toBeDefined();
    const mint = fn.mock.calls.find((call) =>
      String(call[0]).endsWith("/app/installations/42/access_tokens")
    );
    expect(mint).toBeDefined();
    expect(JSON.parse(String((mint?.[1] as RequestInit | undefined)?.body))).toEqual({
      repositories: ["widget"],
      permissions: { contents: "read", metadata: "read" },
    });
    expect((mint?.[1] as RequestInit | undefined)?.headers).toMatchObject({
      "Content-Type": "application/json",
    });
  });

  test("caches independently by installation and repository until near expiry", async () => {
    const fn = installFetchMock({
      token: "ghs_repo_cached",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await getRepositoryInstallationToken("upstream-org/widget");
    const afterFirst = fn.mock.calls.length;
    await getRepositoryInstallationToken("upstream-org/widget");
    expect(fn.mock.calls.length).toBe(afterFirst);

    await getRepositoryInstallationToken("upstream-org/other");
    const mints = fn.mock.calls.filter((call) =>
      String(call[0]).includes("/access_tokens")
    );
    expect(mints).toHaveLength(2);
    expect(JSON.parse(String((mints[1]?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      repositories: ["other"],
    });
  });

  test("re-mints a repository token near expiry without repeating installation lookup", async () => {
    const fn = installFetchMock({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await getRepositoryInstallationToken("upstream-org/widget");
    await getRepositoryInstallationToken("upstream-org/widget");

    expect(fn.mock.calls.filter((call) =>
      String(call[0]).endsWith("/repos/upstream-org/widget/installation")
    )).toHaveLength(1);
    expect(fn.mock.calls.filter((call) =>
      String(call[0]).includes("/access_tokens")
    )).toHaveLength(2);
  });

  test("sandbox auth prefers a narrow App token even when a PAT is configured", async () => {
    process.env.GITHUB_TOKEN = "ghp_broad_deployment_token";
    installFetchMock({ token: "ghs_repo_read_only" });

    await expect(resolveGithubSandboxToken("upstream-org/widget")).resolves.toBe(
      "ghs_repo_read_only",
    );
  });

  test("production refuses to send a PAT into a retained sandbox", async () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_TOKEN = "ghp_broad_deployment_token";
    await withProductionMode("false", async () => {
      await expect(resolveGithubSandboxToken("upstream-org/widget", "org-loop")).rejects.toThrow(
        /retained sandbox.*configure GITHUB_APP_ID.*Contents: read/s,
      );
    });
  });

  test("NODE_ENV=production cannot be overridden to allow a PAT into a sandbox", async () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_TOKEN = "ghp_broad_deployment_token";
    await withProductionMode("true", async () => {
      await expect(resolveGithubSandboxToken("upstream-org/widget", "org-loop")).rejects.toThrow(
        /retained sandbox.*configure GITHUB_APP_ID/s,
      );
    });
  });

  test("production rejects a different product organization before minting", async () => {
    const fn = installFetchMock({ token: "ghs_must_not_mint" });

    await withProductionMode("false", async () => {
      await expect(
        resolveGithubSandboxToken("upstream-org/widget", "org-other"),
      ).rejects.toThrow(/not available to this organization/);
    });
    expect(fn).not.toHaveBeenCalled();
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

  test("repository without an App installation gives an actionable error", async () => {
    installFetchMock({ repositoryInstallationStatus: 404 });
    await expect(
      getRepositoryInstallationToken("upstream-org/private"),
    ).rejects.toThrow(/install the GitHub App on this repository.*Contents: read/s);
  });
});
