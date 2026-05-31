import { timingSafeEqual } from "node:crypto";
import type { IntegrationConnectionAccount } from "@skynet/agent-client/integrations";

const DEFAULT_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const DEFAULT_API_BASE_URL = "https://slack.com/api";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_AUTHORIZE_URL_BYTES = 8 * 1024;
const MAX_CODE_LENGTH = 4_096;
const MAX_STATE_LENGTH = 512;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_SCOPE_COUNT = 128;
const MAX_SCOPE_LENGTH = 256;

export interface SlackOAuthClientConfig {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly botScopes?: readonly string[];
  readonly userScopes?: readonly string[];
  readonly authorizeUrl?: string;
  readonly apiBaseUrl?: string;
}

export interface SlackOAuthCredentialBundle {
  readonly version: 1;
  readonly bot: {
    readonly accessToken: string;
    readonly tokenType: "bot";
    readonly refreshToken?: string;
    readonly expiresAt?: string;
  };
  readonly user?: {
    readonly id: string;
    readonly accessToken: string;
    readonly tokenType: "user";
    readonly refreshToken?: string;
    readonly expiresAt?: string;
  };
}

export interface SlackOAuthSafeProjection {
  readonly externalConnectionId: string;
  readonly externalConnectionName: string;
  readonly account: IntegrationConnectionAccount;
  readonly scopes: readonly string[];
  readonly metadata: {
    readonly appId: string;
    readonly botUserId: string;
    readonly authorizedUserId?: string;
    readonly isEnterpriseInstall: boolean;
    readonly workspace?: { readonly id: string; readonly name?: string };
    readonly enterprise?: { readonly id: string; readonly name?: string };
  };
}

/**
 * Trusted server-only result. `credential` must be sealed before persistence and
 * must never be copied into integration connection projections, events, logs,
 * callback URLs, or sandbox environment variables.
 */
export interface SlackOAuthGrant {
  readonly credential: SlackOAuthCredentialBundle;
  readonly projection: SlackOAuthSafeProjection;
}

export interface SlackOAuthClient {
  buildAuthorizeUrl(input: { readonly state: string; readonly teamId?: string }): string;
  exchangeCode(code: string): Promise<SlackOAuthGrant>;
  completeCallback(input: {
    readonly expectedState: string;
    readonly callback: Readonly<Record<string, string>>;
  }): Promise<SlackOAuthGrant>;
  revokeToken(accessToken: string): Promise<void>;
  revokeCredential(credential: SlackOAuthCredentialBundle): Promise<void>;
}

type SlackFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface SlackOAuthClientDependencies {
  readonly fetch?: SlackFetch;
  readonly now?: () => number;
}

interface SlackOAuthResponse {
  readonly ok?: boolean;
  readonly error?: string;
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly token_type?: string;
  readonly scope?: string;
  readonly bot_user_id?: string;
  readonly app_id?: string;
  readonly is_enterprise_install?: boolean;
  readonly team?: { readonly id?: string; readonly name?: string } | null;
  readonly enterprise?: { readonly id?: string; readonly name?: string } | null;
  readonly authed_user?: {
    readonly id?: string;
    readonly access_token?: string;
    readonly refresh_token?: string;
    readonly expires_in?: number;
    readonly token_type?: string;
    readonly scope?: string;
  } | null;
}

interface SlackRevokeResponse {
  readonly ok?: boolean;
  readonly error?: string;
  readonly revoked?: boolean;
}

function boundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${name} is required`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function optionalBoundedString(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  return value === undefined || value === null ? undefined : boundedString(value, name, maxLength);
}

function normalizeHttpsUrl(value: string, name: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  url.hash = "";
  return url.toString();
}

function normalizeBaseUrl(value: string | undefined): string {
  const url = new URL(value?.trim() || DEFAULT_API_BASE_URL);
  if (url.protocol !== "https:") throw new Error("Slack API base URL must use HTTPS");
  return url.toString().replace(/\/$/u, "");
}

function normalizeAuthorizeUrl(value: string | undefined): string {
  const url = new URL(value?.trim() || DEFAULT_AUTHORIZE_URL);
  if (url.protocol !== "https:") throw new Error("Slack authorize URL must use HTTPS");
  url.hash = "";
  return url.toString();
}

function normalizeScopes(values: readonly string[] | undefined, name: string): string[] {
  if (!values) return [];
  if (values.length > MAX_SCOPE_COUNT) throw new Error(`${name} has too many entries`);
  const scopes = values.map((value) => boundedString(value, name, MAX_SCOPE_LENGTH));
  return [...new Set(scopes)].sort();
}

function parseGrantedScopes(value: unknown, prefix: "bot" | "user"): string[] {
  if (value === undefined || value === null || value === "") return [];
  const scopeString = boundedString(value, `${prefix} scopes`, MAX_AUTHORIZE_URL_BYTES);
  const scopes = scopeString.split(",").map((scope) => scope.trim()).filter(Boolean);
  if (scopes.length > MAX_SCOPE_COUNT) throw new Error(`Slack ${prefix} scope response is too large`);
  return [...new Set(scopes.map((scope) => {
    const normalized = boundedString(scope, `${prefix} scope`, MAX_SCOPE_LENGTH);
    return `${prefix}:${normalized}`;
  }))].sort();
}

function safeProviderError(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,80}$/u.test(value)) return "unknown_error";
  return value;
}

function sameOpaqueState(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function oauthState(value: unknown, name: string): string {
  const state = boundedString(value, name, MAX_STATE_LENGTH);
  if (state.length < 32) throw new Error(`${name} is too short`);
  return state;
}

function expiration(nowMs: number, expiresIn: unknown, name: string): string | undefined {
  if (expiresIn === undefined || expiresIn === null) return undefined;
  if (!Number.isSafeInteger(expiresIn) || Number(expiresIn) <= 0 || Number(expiresIn) > 31_536_000) {
    throw new Error(`${name} is invalid`);
  }
  return new Date(nowMs + Number(expiresIn) * 1_000).toISOString();
}

async function readBoundedJson<T>(response: Response): Promise<T> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error("Slack response exceeded the size limit");
  }
  if (!response.body) throw new Error("Slack returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Slack response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const payload = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Slack returned an invalid response");
    }
    return parsed as T;
  } catch {
    throw new Error("Slack returned an invalid response");
  }
}

function projectGrant(
  response: SlackOAuthResponse,
  config: { readonly appId: string },
  nowMs: number,
): SlackOAuthGrant {
  if (response.app_id !== config.appId) {
    throw new Error("Slack OAuth response does not belong to the configured App");
  }
  const accessToken = boundedString(response.access_token, "Slack bot access token", MAX_TOKEN_LENGTH);
  if (response.token_type !== "bot") throw new Error("Slack OAuth response did not return a bot token");
  const botUserId = boundedString(response.bot_user_id, "Slack bot user id", 128);
  const isEnterpriseInstall = response.is_enterprise_install === true;
  const workspaceId = optionalBoundedString(response.team?.id, "Slack workspace id", 128);
  const workspaceName = optionalBoundedString(response.team?.name, "Slack workspace name", 256);
  const enterpriseId = optionalBoundedString(response.enterprise?.id, "Slack enterprise id", 128);
  const enterpriseName = optionalBoundedString(response.enterprise?.name, "Slack enterprise name", 256);
  const externalConnectionId = isEnterpriseInstall
    ? boundedString(enterpriseId, "Slack enterprise id", 128)
    : boundedString(workspaceId, "Slack workspace id", 128);
  const externalConnectionName = (isEnterpriseInstall ? enterpriseName : workspaceName)
    ?? externalConnectionId;
  const authorizedUserId = optionalBoundedString(
    response.authed_user?.id,
    "Slack authorized user id",
    128,
  );
  const userAccessToken = optionalBoundedString(
    response.authed_user?.access_token,
    "Slack user access token",
    MAX_TOKEN_LENGTH,
  );
  if (userAccessToken && response.authed_user?.token_type !== "user") {
    throw new Error("Slack OAuth response returned an invalid user token type");
  }
  if (userAccessToken && !authorizedUserId) {
    throw new Error("Slack OAuth response omitted the authorized user id");
  }
  const botExpiresAt = expiration(nowMs, response.expires_in, "Slack bot token expiry");
  const userExpiresAt = expiration(
    nowMs,
    response.authed_user?.expires_in,
    "Slack user token expiry",
  );

  const credential: SlackOAuthCredentialBundle = {
    version: 1,
    bot: {
      accessToken,
      tokenType: "bot",
      ...(response.refresh_token
        ? { refreshToken: boundedString(response.refresh_token, "Slack bot refresh token", MAX_TOKEN_LENGTH) }
        : {}),
      ...(botExpiresAt ? { expiresAt: botExpiresAt } : {}),
    },
    ...(userAccessToken && authorizedUserId
      ? {
          user: {
            id: authorizedUserId,
            accessToken: userAccessToken,
            tokenType: "user" as const,
            ...(response.authed_user?.refresh_token
              ? {
                  refreshToken: boundedString(
                    response.authed_user.refresh_token,
                    "Slack user refresh token",
                    MAX_TOKEN_LENGTH,
                  ),
                }
              : {}),
            ...(userExpiresAt ? { expiresAt: userExpiresAt } : {}),
          },
        }
      : {}),
  };

  return {
    credential,
    projection: {
      externalConnectionId,
      externalConnectionName,
      account: {
        externalAccountId: externalConnectionId,
        displayName: externalConnectionName,
      },
      scopes: [
        ...parseGrantedScopes(response.scope, "bot"),
        ...parseGrantedScopes(response.authed_user?.scope, "user"),
      ].sort(),
      metadata: {
        appId: config.appId,
        botUserId,
        ...(authorizedUserId ? { authorizedUserId } : {}),
        isEnterpriseInstall,
        ...(workspaceId
          ? { workspace: { id: workspaceId, ...(workspaceName ? { name: workspaceName } : {}) } }
          : {}),
        ...(enterpriseId
          ? { enterprise: { id: enterpriseId, ...(enterpriseName ? { name: enterpriseName } : {}) } }
          : {}),
      },
    },
  };
}

export function createSlackOAuthClient(
  input: SlackOAuthClientConfig,
  dependencies: SlackOAuthClientDependencies = {},
): SlackOAuthClient {
  const config = {
    appId: boundedString(input.appId, "Slack App id", 128),
    clientId: boundedString(input.clientId, "Slack client id", 256),
    clientSecret: boundedString(input.clientSecret, "Slack client secret", 512),
    redirectUri: normalizeHttpsUrl(input.redirectUri, "Slack redirect URI"),
    botScopes: normalizeScopes(input.botScopes, "Slack bot scope"),
    userScopes: normalizeScopes(input.userScopes, "Slack user scope"),
    authorizeUrl: normalizeAuthorizeUrl(input.authorizeUrl),
    apiBaseUrl: normalizeBaseUrl(input.apiBaseUrl),
  };
  if (config.botScopes.length === 0 && config.userScopes.length === 0) {
    throw new Error("Slack OAuth requires at least one scope");
  }
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;

  async function request<T>(path: string, init: RequestInit): Promise<{ response: Response; body: T }> {
    const response = await fetchImpl(`${config.apiBaseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { response, body: await readBoundedJson<T>(response) };
  }

  async function revokeToken(accessToken: string): Promise<void> {
    const token = boundedString(accessToken, "Slack access token", MAX_TOKEN_LENGTH);
    const { response, body } = await request<SlackRevokeResponse>("/auth.revoke", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
    const providerError = safeProviderError(body.error);
    if (providerError === "token_revoked") return;
    if (!response.ok || body.ok !== true || body.revoked !== true) {
      throw new Error(
        response.ok
          ? `Slack token revocation failed: ${providerError}`
          : `Slack token revocation failed: HTTP ${response.status}`,
      );
    }
  }

  async function exchangeCode(code: string): Promise<SlackOAuthGrant> {
    const body = new URLSearchParams({
      code: boundedString(code, "Slack OAuth code", MAX_CODE_LENGTH),
      redirect_uri: config.redirectUri,
    });
    const { response, body: oauth } = await request<SlackOAuthResponse>("/oauth.v2.access", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`Slack OAuth exchange failed: HTTP ${response.status}`);
    }
    if (oauth.ok !== true) {
      throw new Error(`Slack OAuth exchange failed: ${safeProviderError(oauth.error)}`);
    }
    return projectGrant(oauth, config, now());
  }

  return {
    buildAuthorizeUrl({ state, teamId }) {
      const safeState = oauthState(state, "Slack OAuth state");
      const url = new URL(config.authorizeUrl);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("state", safeState);
      if (config.botScopes.length > 0) url.searchParams.set("scope", config.botScopes.join(","));
      if (config.userScopes.length > 0) {
        url.searchParams.set("user_scope", config.userScopes.join(","));
      }
      if (teamId) url.searchParams.set("team", boundedString(teamId, "Slack team id", 128));
      const output = url.toString();
      if (Buffer.byteLength(output) > MAX_AUTHORIZE_URL_BYTES) {
        throw new Error("Slack authorize URL exceeded the size limit");
      }
      return output;
    },

    exchangeCode,

    async completeCallback({ expectedState, callback }) {
      const safeExpectedState = oauthState(
        expectedState,
        "Expected Slack OAuth state",
      );
      const actualState = oauthState(callback.state, "Slack OAuth state");
      if (!sameOpaqueState(actualState, safeExpectedState)) {
        throw new Error("Slack OAuth state mismatch");
      }
      if (callback.error) {
        throw new Error(`Slack authorization failed: ${safeProviderError(callback.error)}`);
      }
      return exchangeCode(callback.code ?? "");
    },

    revokeToken,

    async revokeCredential(credential) {
      const tokens = [credential.bot.accessToken, credential.user?.accessToken].filter(
        (token): token is string => typeof token === "string",
      );
      for (const token of new Set(tokens)) await revokeToken(token);
    },
  };
}
