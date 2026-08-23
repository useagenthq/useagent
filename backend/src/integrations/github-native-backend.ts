import { createPrivateKey, createSign } from "node:crypto";
import type { IntegrationConnectionStatus } from "@useagent/agent-client/integrations";
import type {
  DelegatedConnectionBackend,
  DelegatedConnectionResult,
} from "./backend";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_WEB_BASE_URL = "https://github.com";
const GITHUB_API_VERSION = "2022-11-28";
const JWT_TTL_SECONDS = 9 * 60;
const FETCH_TIMEOUT_MS = 8_000;

export const GITHUB_NATIVE_RUNTIME_BINDING_ID = "native:github-app";

export interface GithubNativeConnectionConfig {
  readonly appId: string;
  readonly appSlug: string;
  readonly privateKey: string;
  readonly apiBaseUrl?: string;
  readonly webBaseUrl?: string;
}

export interface GithubInstallationAccount {
  readonly id: number;
  readonly login: string;
  readonly avatarUrl?: string;
  readonly type?: string;
}

export interface GithubInstallationProjection {
  readonly installationId: number;
  readonly appId: string;
  readonly appSlug: string;
  readonly repositorySelection: "all" | "selected";
  readonly account: GithubInstallationAccount;
  readonly permissions: readonly string[];
  readonly status: IntegrationConnectionStatus;
}

export interface GithubNativeConnectionBackend {
  buildInstallUrl(input: { readonly state: string }): string;
  validateApp(): Promise<{ readonly appId: string; readonly appSlug: string }>;
  inspectInstallation(installationId: number): Promise<GithubInstallationProjection>;
  completeInstall(installationId: number): Promise<DelegatedConnectionResult>;
  disconnectInstallation(installationId: number): Promise<void>;
}

export function githubNativeConnectionConfigFromEnv(): GithubNativeConnectionConfig | null {
  const appId = process.env.GITHUB_CONNECTION_APP_ID?.trim();
  const privateKey = process.env.GITHUB_CONNECTION_APP_PRIVATE_KEY?.trim();
  const appSlug = process.env.GITHUB_CONNECTION_APP_SLUG?.trim();
  if (!appId && !privateKey && !appSlug) return null;
  if (!appId || !privateKey || !appSlug) {
    console.warn(
      "[integrations] GitHub customer connection is partially configured and remains disabled",
    );
    return null;
  }
  const normalizedKey = privateKey.replace(/\\n/gu, "\n");
  if (!normalizedKey.includes("-----BEGIN")) {
    console.warn("[integrations] GitHub customer connection private key is invalid");
    return null;
  }
  return { appId, appSlug, privateKey: normalizedKey };
}

interface GithubAppResponse {
  readonly id?: number;
  readonly slug?: string;
}

interface GithubInstallationResponse {
  readonly id?: number;
  readonly app_id?: number;
  readonly app_slug?: string;
  readonly repository_selection?: string;
  readonly suspended_at?: string | null;
  readonly account?: {
    readonly id?: number;
    readonly login?: string;
    readonly avatar_url?: string;
    readonly type?: string;
  } | null;
  readonly permissions?: Readonly<Record<string, string>>;
}

type GithubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface GithubNativeBackendDependencies {
  readonly fetch?: GithubFetch;
  readonly now?: () => number;
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const url = new URL(value?.trim() || fallback);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("GitHub base URL must use HTTPS");
  }
  return url.toString().replace(/\/$/u, "");
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signAppJwt(config: GithubNativeConnectionConfig, nowMs: number): string {
  const nowSeconds = Math.floor(nowMs / 1_000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + JWT_TTL_SECONDS,
      iss: config.appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(createPrivateKey(config.privateKey));
  return `${signingInput}.${base64url(signature)}`;
}

function permissionScopes(permissions: Readonly<Record<string, string>> | undefined): string[] {
  if (!permissions) return [];
  const elevated = Object.entries(permissions)
    .filter(([, access]) => access !== "read" && access !== "none")
    .map(([permission, access]) => `${permission}:${access}`);
  if (elevated.length > 0) {
    throw new Error(
      `GitHub installation has non-read-only permissions: ${elevated.sort().join(", ")}`,
    );
  }
  return Object.entries(permissions)
    .filter(([, access]) => access === "read")
    .map(([permission]) => `${permission}:read`)
    .sort();
}

function projectInstallation(
  config: GithubNativeConnectionConfig,
  body: GithubInstallationResponse,
): GithubInstallationProjection {
  const installationId = positiveInteger(body.id ?? 0, "GitHub installation id");
  const appId = String(body.app_id ?? "");
  if (appId !== config.appId) {
    throw new Error("GitHub installation does not belong to the configured App");
  }
  if (body.app_slug && body.app_slug !== config.appSlug) {
    throw new Error("GitHub installation App slug does not match the configured App");
  }
  const accountId = positiveInteger(body.account?.id ?? 0, "GitHub installation account id");
  const login = required(body.account?.login ?? "", "GitHub installation account login");
  const repositorySelection = body.repository_selection;
  if (repositorySelection !== "all" && repositorySelection !== "selected") {
    throw new Error("GitHub installation returned an invalid repository selection");
  }
  return {
    installationId,
    appId,
    appSlug: body.app_slug ?? config.appSlug,
    repositorySelection,
    account: {
      id: accountId,
      login,
      ...(body.account?.avatar_url ? { avatarUrl: body.account.avatar_url } : {}),
      ...(body.account?.type ? { type: body.account.type } : {}),
    },
    permissions: permissionScopes(body.permissions),
    status: body.suspended_at ? "unhealthy" : "connected",
  };
}

export function createGithubNativeConnectionBackend(
  input: GithubNativeConnectionConfig,
  dependencies: GithubNativeBackendDependencies = {},
): GithubNativeConnectionBackend {
  const config = {
    appId: required(input.appId, "GitHub App id"),
    appSlug: required(input.appSlug, "GitHub App slug"),
    privateKey: required(input.privateKey, "GitHub App private key"),
    apiBaseUrl: normalizeBaseUrl(input.apiBaseUrl, DEFAULT_API_BASE_URL),
    webBaseUrl: normalizeBaseUrl(input.webBaseUrl, DEFAULT_WEB_BASE_URL),
  };
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;

  async function githubRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetchImpl(`${config.apiBaseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": "useagent",
          Authorization: `Bearer ${signAppJwt(config, now())}`,
          ...init.headers,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function inspectInstallation(
    installationId: number,
  ): Promise<GithubInstallationProjection> {
    const id = positiveInteger(installationId, "GitHub installation id");
    const response = await githubRequest(`/app/installations/${id}`);
    if (response.status === 404) {
      throw new Error("GitHub installation was not found or has been removed");
    }
    if (!response.ok) {
      throw new Error(`GitHub installation lookup failed: HTTP ${response.status}`);
    }
    return projectInstallation(config, (await response.json()) as GithubInstallationResponse);
  }

  return {
    buildInstallUrl({ state }) {
      const safeState = required(state, "GitHub installation state");
      const url = new URL(`/apps/${encodeURIComponent(config.appSlug)}/installations/new`, config.webBaseUrl);
      url.searchParams.set("state", safeState);
      return url.toString();
    },

    async validateApp() {
      const response = await githubRequest("/app");
      if (!response.ok) {
        throw new Error(`GitHub App validation failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as GithubAppResponse;
      if (String(body.id ?? "") !== config.appId || body.slug !== config.appSlug) {
        throw new Error("GitHub App credentials do not match the configured App identity");
      }
      return { appId: config.appId, appSlug: config.appSlug };
    },

    inspectInstallation,

    async completeInstall(installationId) {
      const installation = await inspectInstallation(installationId);
      if (installation.status !== "connected") {
        throw new Error("GitHub installation is suspended");
      }
      return {
        runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID,
        externalConnectionId: String(installation.installationId),
        externalConnectionName: installation.account.login,
        authMethod: "custom_credential",
        account: {
          externalAccountId: String(installation.account.id),
          displayName: installation.account.login,
          ...(installation.account.avatarUrl ? { avatarUrl: installation.account.avatarUrl } : {}),
        },
        scopes: installation.permissions,
      };
    },

    async disconnectInstallation(installationId) {
      const id = positiveInteger(installationId, "GitHub installation id");
      const response = await githubRequest(`/app/installations/${id}`, { method: "DELETE" });
      if (response.status === 404) return;
      if (response.status !== 204) {
        throw new Error(`GitHub installation disconnect failed: HTTP ${response.status}`);
      }
    },
  };
}

export function createGithubDelegatedConnectionBackend(
  config: GithubNativeConnectionConfig,
  dependencies: GithubNativeBackendDependencies = {},
): DelegatedConnectionBackend {
  const github = createGithubNativeConnectionBackend(config, dependencies);
  return {
    kind: "delegated",
    runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID,
    disconnectSupported: true,
    supports: (provider) => provider === "github",
    async listConnectableProviders() {
      return ["github"];
    },
    async startConnect(input) {
      return {
        backendSessionRef: input.state,
        runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID,
        redirectUrl: github.buildInstallUrl({ state: input.state }),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      };
    },
    async completeConnect(input) {
      const rawInstallationId = input.callback?.installation_id;
      if (!rawInstallationId || !/^\d{1,20}$/u.test(rawInstallationId)) {
        throw new Error("GitHub installation callback is missing installation_id");
      }
      const setupAction = input.callback?.setup_action;
      if (setupAction && setupAction !== "install" && setupAction !== "update") {
        throw new Error("GitHub installation callback has an invalid setup_action");
      }
      return github.completeInstall(Number(rawInstallationId));
    },
    async disconnect(input) {
      await github.disconnectInstallation(Number(input.connection.externalConnectionId));
    },
    async listActions() {
      return [];
    },
    async executeAction() {
      throw new Error("GitHub actions use the native repository gateway");
    },
  };
}
