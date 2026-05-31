import type { DelegatedConnectionBackend } from "./backend";
import type { IntegrationConnectionRecord } from "./connection-repo";
import { readIntegrationCredential } from "./credential-repo";
import {
  createSlackOAuthClient,
  type SlackOAuthClient,
  type SlackOAuthCredentialBundle,
} from "./slack-oauth-client";

export const SLACK_NATIVE_RUNTIME_BINDING_ID = "native:slack-oauth";
export const SLACK_OAUTH_CREDENTIAL_FORMAT = "slack-oauth-v1";

const CONNECT_TTL_MS = 10 * 60_000;
const DEFAULT_BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users:read",
  "users:read.email",
] as const;

export interface SlackNativeConnectionConfig {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly botScopes: readonly string[];
  readonly userScopes: readonly string[];
}

export interface SlackStoredCredentialEnvelope {
  readonly version: 1;
  readonly provider: "slack";
  readonly externalConnectionId: string;
  readonly credential: SlackOAuthCredentialBundle;
}

interface SlackNativeBackendDependencies {
  readonly client?: SlackOAuthClient;
  readonly now?: () => number;
  readonly readCredential?: typeof readIntegrationCredential;
}

function splitScopes(value: string | undefined, fallback: readonly string[] = []): string[] {
  const scopes = (value?.split(",") ?? fallback)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return [...new Set(scopes)];
}

export function slackNativeConnectionConfigFromEnv(): SlackNativeConnectionConfig | null {
  const appId = process.env.SLACK_APP_ID?.trim();
  const clientId = process.env.SLACK_CLIENT_ID?.trim();
  const clientSecret = process.env.SLACK_CLIENT_SECRET?.trim();
  if (!appId && !clientId && !clientSecret) return null;
  if (!appId || !clientId || !clientSecret) {
    console.warn("[integrations] Slack customer OAuth is partially configured and remains disabled");
    return null;
  }
  const publicOrigin = process.env.BETTER_AUTH_URL?.trim() || process.env.FRONTEND_ORIGIN?.trim();
  const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI?.trim()
    || (publicOrigin
      ? new URL("/api/integrations/callback/slack", publicOrigin).toString()
      : "");
  if (!redirectUri) {
    console.warn("[integrations] Slack customer OAuth redirect URI is not configured");
    return null;
  }
  try {
    if (new URL(redirectUri).protocol !== "https:") {
      console.warn("[integrations] Slack customer OAuth redirect URI must use HTTPS");
      return null;
    }
  } catch {
    console.warn("[integrations] Slack customer OAuth redirect URI is invalid");
    return null;
  }
  return {
    appId,
    clientId,
    clientSecret,
    redirectUri,
    botScopes: splitScopes(process.env.SLACK_OAUTH_BOT_SCOPES, DEFAULT_BOT_SCOPES),
    userScopes: splitScopes(process.env.SLACK_OAUTH_USER_SCOPES),
  };
}

function requiredCallbackValue(
  callback: Readonly<Record<string, string>> | undefined,
  key: string,
): string {
  const value = callback?.[key]?.trim();
  if (!value || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Slack OAuth callback is missing ${key}`);
  }
  return value;
}

function safeProviderError(value: string): string {
  return /^[a-z0-9_]{1,80}$/u.test(value) ? value : "unknown_error";
}

export function serializeSlackCredential(
  externalConnectionId: string,
  credential: SlackOAuthCredentialBundle,
): string {
  return JSON.stringify({
    version: 1,
    provider: "slack",
    externalConnectionId,
    credential,
  } satisfies SlackStoredCredentialEnvelope);
}

export function decodeSlackStoredCredential(
  serialized: string,
  expectedExternalConnectionId: string,
): SlackOAuthCredentialBundle {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Slack integration credential is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Slack integration credential is invalid");
  }
  const envelope = value as Partial<SlackStoredCredentialEnvelope>;
  if (
    envelope.version !== 1
    || envelope.provider !== "slack"
    || envelope.externalConnectionId !== expectedExternalConnectionId
    || !envelope.credential
    || envelope.credential.version !== 1
    || typeof envelope.credential.bot?.accessToken !== "string"
    || envelope.credential.bot.tokenType !== "bot"
  ) {
    throw new Error("Slack integration credential is invalid");
  }
  return envelope.credential;
}

export async function readSlackCredential(
  connection: Pick<
    IntegrationConnectionRecord,
    "id" | "orgId" | "provider" | "externalConnectionId"
  >,
  readCredential: typeof readIntegrationCredential = readIntegrationCredential,
): Promise<SlackOAuthCredentialBundle | null> {
  const material = await readCredential({
    connectionId: connection.id,
    orgId: connection.orgId,
    provider: connection.provider,
    externalConnectionId: connection.externalConnectionId,
  });
  if (!material) return null;
  if (material.format !== SLACK_OAUTH_CREDENTIAL_FORMAT) {
    throw new Error("Slack integration credential format is unsupported");
  }
  return decodeSlackStoredCredential(material.serialized, connection.externalConnectionId);
}

export function createSlackDelegatedConnectionBackend(
  config: SlackNativeConnectionConfig,
  dependencies: SlackNativeBackendDependencies = {},
): DelegatedConnectionBackend {
  const client = dependencies.client ?? createSlackOAuthClient(config);
  const now = dependencies.now ?? Date.now;
  const readCredential = dependencies.readCredential ?? readIntegrationCredential;
  return {
    kind: "delegated",
    runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
    disconnectSupported: true,
    supports: (provider) => provider === "slack",
    async listConnectableProviders() {
      return ["slack"];
    },
    async startConnect(input) {
      return {
        backendSessionRef: input.state,
        runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
        redirectUrl: client.buildAuthorizeUrl({ state: input.state }),
        expiresAt: new Date(now() + CONNECT_TTL_MS),
      };
    },
    async completeConnect(input) {
      const providerError = input.callback?.error?.trim();
      if (providerError) {
        throw new Error(`Slack authorization failed: ${safeProviderError(providerError)}`);
      }
      const grant = await client.exchangeCode(requiredCallbackValue(input.callback, "code"));
      return {
        runtimeBindingId: SLACK_NATIVE_RUNTIME_BINDING_ID,
        externalConnectionId: grant.projection.externalConnectionId,
        externalConnectionName: grant.projection.externalConnectionName,
        authMethod: "oauth2",
        account: grant.projection.account,
        scopes: grant.projection.scopes,
        credential: {
          format: SLACK_OAUTH_CREDENTIAL_FORMAT,
          serialized: serializeSlackCredential(
            grant.projection.externalConnectionId,
            grant.credential,
          ),
        },
        workspaceBinding: {
          externalWorkspaceId: grant.projection.externalConnectionId,
          ...(grant.projection.metadata.authorizedUserId
            ? { externalActorId: grant.projection.metadata.authorizedUserId }
            : {}),
        },
      };
    },
    async disconnect(input) {
      const credential = await readSlackCredential(input.connection, readCredential);
      if (credential) await client.revokeCredential(credential);
    },
    async listActions() {
      return [];
    },
    async executeAction() {
      throw new Error("Slack actions use the native Slack gateway");
    },
  };
}
