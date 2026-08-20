import { createPrivateKey, createSign } from "node:crypto";
import { githubAppConfig, type GithubAppConfig } from "../env";

// ---------------------------------------------------------------------------
// GitHub App → installation access tokens. Backend-only repository discovery
// uses an installation-wide token. Retained sandboxes receive a separate token
// narrowed by GitHub to one exact repository and read-only clone permissions:
//
//   1. sign an App JWT (RS256) with the private key,
//   2. resolve the installation (by org for discovery, exact repo for sandbox),
//   3. POST /app/installations/{id}/access_tokens with the required scope.
//
// The minted token is cached and reused until it is close to expiry, so a burst
// of runs shares one token instead of re-minting per call. Nothing here is ever
// logged; only the token string leaves this module, and only to the HTTP layer
// that already handles it as a secret.
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 8_000;
/** Re-mint this long before the stated expiry, so a token handed out here still
 *  has comfortable life left by the time a clone actually uses it (~55 min). */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** App JWT lifetime — GitHub caps it at 10 min; 9 leaves room for clock skew. */
const JWT_TTL_SEC = 9 * 60;

/** A minted installation token and the epoch-ms at which GitHub expires it. */
export interface InstallationToken {
  token: string;
  expiresAt: number;
}

interface GhInstallation {
  id: number;
  account: { login: string } | null;
}

/** Backend-only installation-wide tokens used for repository discovery. */
const installationTokenCache = new Map<string, InstallationToken>();
const installationTokenInflight = new Map<string, Promise<InstallationToken>>();
/** Sandbox tokens are isolated by App, installation, and exact repository. */
const repositoryTokenCache = new Map<string, InstallationToken>();
const repositoryTokenInflight = new Map<string, Promise<InstallationToken>>();
/** Repository -> installation is stable for the life of the process. */
const repositoryInstallations = new Map<string, number>();

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Sign a GitHub App JWT (RS256) — the credential that authenticates as the App
 * itself (not an installation). `iss` is the numeric App id; GitHub rejects a
 * future `iat`, so backdate 60s for clock skew.
 */
function signAppJwt(cfg: GithubAppConfig, nowSec: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + JWT_TTL_SEC, iss: cfg.appId }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(createPrivateKey(cfg.privateKey));
  return `${signingInput}.${base64url(signature)}`;
}

function appJwtHeaders(jwt: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "skynet-a",
    Authorization: `Bearer ${jwt}`,
  };
}

/** Fetch with a bounded timeout; the caller turns a throw into an honest error. */
async function ghFetch(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick the installation to mint from: the one whose account matches `org`
 * (case-insensitive); if no org is configured and there's exactly one
 * installation, use it. Ambiguity and absence are hard, named errors so a
 * misconfiguration reports what's actually wrong instead of failing vaguely.
 */
function pickInstallation(
  installations: GhInstallation[],
  org: string | null,
): GhInstallation {
  if (installations.length === 0) {
    throw new Error(
      "GitHub App has no installations; install the App on the target org.",
    );
  }
  if (org) {
    const match = installations.find(
      (i) => i.account?.login?.toLowerCase() === org.toLowerCase(),
    );
    if (match) return match;
    const logins = installations.map((i) => i.account?.login ?? "?").join(", ");
    throw new Error(
      `GitHub App is not installed on org "${org}"; installed on: [${logins}]. ` +
        "Set GITHUB_ORG to one of these or install the App on the org.",
    );
  }
  const [only] = installations;
  if (installations.length === 1 && only) return only;
  const logins = installations.map((i) => i.account?.login ?? "?").join(", ");
  throw new Error(
    `GitHub App has multiple installations ([${logins}]); set GITHUB_ORG to disambiguate.`,
  );
}

/** Run the full JWT → installation → access-token flow once. */
async function mintInstallationToken(
  cfg: GithubAppConfig,
): Promise<InstallationToken> {
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = signAppJwt(cfg, nowSec);
  const headers = appJwtHeaders(jwt);

  const insRes = await ghFetch(`${GITHUB_API}/app/installations`, { headers });
  if (!insRes.ok) {
    const hint =
      insRes.status === 401
        ? " (JWT rejected: check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)"
        : "";
    throw new Error(`GitHub App installations lookup failed: HTTP ${insRes.status}${hint}`);
  }
  const installations = (await insRes.json()) as GhInstallation[];
  const chosen = pickInstallation(installations, cfg.org);

  const tokRes = await ghFetch(
    `${GITHUB_API}/app/installations/${chosen.id}/access_tokens`,
    { method: "POST", headers },
  );
  if (!tokRes.ok) {
    throw new Error(
      `GitHub App token mint failed for installation ${chosen.id}: HTTP ${tokRes.status}`,
    );
  }
  const body = (await tokRes.json()) as { token?: string; expires_at?: string };
  if (!body.token) throw new Error("GitHub App token mint returned no token");
  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 55 * 60_000;
  return { token: body.token, expiresAt };
}

function parseRepository(repository: string): { owner: string; name: string } {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/u.exec(
    repository,
  );
  if (!match?.[1] || !match[2] || match[2] === "." || match[2] === "..") {
    throw new Error(`invalid GitHub repository "${repository}"; expected owner/name`);
  }
  return { owner: match[1], name: match[2] };
}

async function repositoryInstallationId(
  cfg: GithubAppConfig,
  repository: string,
  headers: Record<string, string>,
): Promise<number> {
  const { owner, name } = parseRepository(repository);
  const lookupKey = `${cfg.appId}|${owner.toLowerCase()}/${name.toLowerCase()}`;
  const cached = repositoryInstallations.get(lookupKey);
  if (cached !== undefined) return cached;

  const response = await ghFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
    { headers },
  );
  if (!response.ok) {
    const hint = response.status === 404
      ? " (install the GitHub App on this repository and grant Contents: read)"
      : "";
    throw new Error(
      `GitHub App installation lookup failed for ${repository}: HTTP ${response.status}${hint}`,
    );
  }
  const body = (await response.json()) as { id?: number };
  const installationId = body.id;
  if (typeof installationId !== "number" || !Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error(`GitHub App installation lookup returned no installation id for ${repository}`);
  }
  repositoryInstallations.set(lookupKey, installationId);
  return installationId;
}

async function mintRepositoryInstallationToken(
  cfg: GithubAppConfig,
  repository: string,
): Promise<{ key: string; token: InstallationToken }> {
  const { name } = parseRepository(repository);
  const jwt = signAppJwt(cfg, Math.floor(Date.now() / 1000));
  const headers = appJwtHeaders(jwt);
  const installationId = await repositoryInstallationId(cfg, repository, headers);
  const key = `${cfg.appId}|${installationId}|${repository.toLowerCase()}`;

  const now = Date.now();
  const cached = repositoryTokenCache.get(key);
  if (cached && cached.expiresAt - now > REFRESH_MARGIN_MS) {
    return { key, token: cached };
  }

  const response = await ghFetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        repositories: [name],
        permissions: { contents: "read", metadata: "read" },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub App repository token mint failed for ${repository}: HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as { token?: string; expires_at?: string };
  if (!body.token) {
    throw new Error(`GitHub App repository token mint returned no token for ${repository}`);
  }
  const expiresAt = body.expires_at
    ? Date.parse(body.expires_at)
    : Date.now() + 55 * 60_000;
  return { key, token: { token: body.token, expiresAt } };
}

/**
 * Return a valid installation token for the configured App, minting on first use
 * and re-minting once the cached one nears expiry. Concurrent callers during a
 * cold/expired window share a single mint. Throws (honestly) if the App is
 * unconfigured or GitHub rejects the creds — the caller degrades to an error
 * listing / failed clone rather than a silent empty result.
 */
export async function getInstallationToken(
  cfg: GithubAppConfig = githubAppConfig() ??
    (() => {
      throw new Error("GitHub App is not configured");
    })(),
): Promise<InstallationToken> {
  const key = `${cfg.appId}|${cfg.org ?? ""}`;
  const now = Date.now();
  const cached = installationTokenCache.get(key);
  if (cached && cached.expiresAt - now > REFRESH_MARGIN_MS) {
    return cached;
  }
  const active = installationTokenInflight.get(key);
  if (active) return active;
  const mint = (async (): Promise<InstallationToken> => {
    try {
      const token = await mintInstallationToken(cfg);
      installationTokenCache.set(key, token);
      return token;
    } finally {
      installationTokenInflight.delete(key);
    }
  })();
  installationTokenInflight.set(key, mint);
  return mint;
}

/**
 * Mint a token that can read exactly one repository. This is the only App token
 * suitable for crossing into a retained sandbox: GitHub constrains it to the
 * named repository and to read-only Contents + Metadata permissions.
 */
export async function getRepositoryInstallationToken(
  repository: string,
  cfg: GithubAppConfig = githubAppConfig() ??
    (() => {
      throw new Error("GitHub App is not configured");
    })(),
): Promise<InstallationToken> {
  const parsed = parseRepository(repository);
  const repositoryKey = `${cfg.appId}|${parsed.owner.toLowerCase()}/${parsed.name.toLowerCase()}`;
  const installationId = repositoryInstallations.get(repositoryKey);
  if (installationId !== undefined) {
    const tokenKey = `${cfg.appId}|${installationId}|${repository.toLowerCase()}`;
    const cached = repositoryTokenCache.get(tokenKey);
    if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached;
  }

  const provisionalKey = `${cfg.appId}|pending|${repository.toLowerCase()}`;
  const pending = repositoryTokenInflight.get(provisionalKey);
  if (pending) return pending;
  const mint = (async (): Promise<InstallationToken> => {
    try {
      const result = await mintRepositoryInstallationToken(cfg, repository);
      repositoryTokenCache.set(result.key, result.token);
      return result.token;
    } finally {
      repositoryTokenInflight.delete(provisionalKey);
    }
  })();
  repositoryTokenInflight.set(provisionalKey, mint);
  return mint;
}

/** Test/ops hook: drop the cached installation token so the next call re-mints. */
export function clearInstallationTokenCache(): void {
  installationTokenCache.clear();
  installationTokenInflight.clear();
  repositoryTokenCache.clear();
  repositoryTokenInflight.clear();
  repositoryInstallations.clear();
}
