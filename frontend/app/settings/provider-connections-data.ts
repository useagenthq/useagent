/**
 * Provider connection UI model. Mirrors the public metadata-only backend API;
 * credential values are intentionally absent from every read shape.
 */
import {
  decodeProviderConnectionMeta,
  decodeProviderConnections,
  PROVIDER_CONNECTION_AUTH_METHODS,
  PROVIDER_CONNECTION_PROVIDERS,
  PROVIDER_CONNECTION_STATUSES,
  type ProviderConnectionAuthMethod,
  type ProviderConnectionMeta,
  type ProviderConnectionMetadata,
  type ProviderConnectionProvider,
  type ProviderConnectionStatus,
} from "@useagent/agent-client/provider-connections";

export {
  PROVIDER_CONNECTION_AUTH_METHODS,
  PROVIDER_CONNECTION_PROVIDERS,
  PROVIDER_CONNECTION_STATUSES,
  type ProviderConnectionAuthMethod,
  type ProviderConnectionMeta,
  type ProviderConnectionMetadata,
  type ProviderConnectionProvider,
  type ProviderConnectionStatus,
};

export type CodexChatGptLogin =
  | {
      type: "chatgpt";
      loginId: string;
      authUrl: string;
    }
  | {
      type: "chatgptDeviceCode";
      loginId: string;
      verificationUrl: string;
      userCode: string;
    };

export interface CodexChatGptStatus {
  account: {
    authMode: string | null;
    email: string | null;
    planType: string | null;
  } | null;
  requiresOpenaiAuth: boolean;
}

export interface ProviderConnectionView {
  provider: ProviderConnectionProvider;
  apiKey: ProviderConnectionMeta | null;
  chatGptOAuth: ProviderConnectionMeta | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const safeProviderConnectionMeta = decodeProviderConnectionMeta;
export const safeProviderConnections = decodeProviderConnections;

export function safeCodexChatGptLogin(value: unknown): CodexChatGptLogin | null {
  if (!isRecord(value) || typeof value.loginId !== "string") return null;
  if (value.type === "chatgpt" && typeof value.authUrl === "string") {
    const authUrl = safeExternalAuthUrl(value.authUrl);
    return authUrl ? { type: value.type, loginId: value.loginId, authUrl } : null;
  }
  if (
    value.type === "chatgptDeviceCode" &&
    typeof value.verificationUrl === "string" &&
    typeof value.userCode === "string"
  ) {
    const verificationUrl = safeExternalAuthUrl(value.verificationUrl);
    if (!verificationUrl) return null;
    return {
      type: value.type,
      loginId: value.loginId,
      verificationUrl,
      userCode: value.userCode,
    };
  }
  return null;
}

export function safeCodexChatGptStatus(value: unknown): CodexChatGptStatus | null {
  if (!isRecord(value) || typeof value.requiresOpenaiAuth !== "boolean") return null;
  if (value.account === null) {
    return { account: null, requiresOpenaiAuth: value.requiresOpenaiAuth };
  }
  if (!isRecord(value.account)) return null;
  const { authMode, email, planType } = value.account;
  if (
    (authMode !== null && typeof authMode !== "string") ||
    (email !== null && typeof email !== "string") ||
    (planType !== null && typeof planType !== "string")
  ) {
    return null;
  }
  return {
    account: { authMode, email, planType },
    requiresOpenaiAuth: value.requiresOpenaiAuth,
  };
}

export function safeEnabledSandboxEngines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((engine): engine is string => typeof engine === "string"))];
}

export const PROVIDER_LABELS: Record<
  ProviderConnectionProvider,
  { name: string; scope: string; keyHint: string; keyPlaceholder: string }
> = {
  openai: {
    name: "OpenAI",
    scope: "Codex and OpenAI-compatible runs",
    keyHint: "OpenAI API key",
    keyPlaceholder: "sk-...",
  },
  anthropic: {
    name: "Anthropic",
    scope: "Claude API and Anthropic-compatible runs",
    keyHint: "Anthropic API key",
    keyPlaceholder: "sk-ant-...",
  },
  openrouter: {
    name: "OpenRouter",
    scope: "OpenRouter model routing",
    keyHint: "OpenRouter API key",
    keyPlaceholder: "sk-or-v1-...",
  },
};

export function providerConnectionViews(
  connections: ProviderConnectionMeta[],
): ProviderConnectionView[] {
  return PROVIDER_CONNECTION_PROVIDERS.map((provider) => {
    const providerConnections = connections.filter((item) => item.provider === provider);
    return {
      provider,
      apiKey: providerConnections.find((item) => item.authMethod === "api_key") ?? null,
      chatGptOAuth: providerConnections.find((item) => item.authMethod === "chatgpt_oauth") ?? null,
    };
  });
}

export function isActiveConnection(connection: ProviderConnectionMeta | null): boolean {
  return connection?.status === "connected";
}

export function providerStatusConnection(
  ...connections: (ProviderConnectionMeta | null)[]
): ProviderConnectionMeta | null {
  return (
    connections.find(isActiveConnection) ??
    connections.find((connection) => connection?.status === "reauth_required") ??
    connections.find((connection) => connection !== null) ??
    null
  );
}

export function accountLabel(connection: ProviderConnectionMeta | null): string {
  if (!connection) return "No account metadata";
  return connection.metadata.email ?? connection.metadata.planType ?? "Account metadata saved";
}

export function statusLabel(connection: ProviderConnectionMeta | null): string {
  if (!connection) return "Not connected";
  if (connection.status === "connected") return "Connected";
  if (connection.status === "reauth_required") return "Reauth required";
  return "Revoked";
}

/** Quiet, consistent tone for a status chip. "Connected" is the only positive
 *  (green) state; "Reauth required" keeps a subdued attention tone; every other
 *  state - "Not connected" (a normal, expected state) and "Revoked" (a quiet
 *  outcome, not an alarm) - is neutral gray. The revoked chip adds a small red
 *  dot at the call site so it stays distinguishable without shouting. */
export type ConnectionBadgeStatus = "completed" | "pending" | "disabled";

export function connectionBadgeStatus(
  connection: ProviderConnectionMeta | null,
): ConnectionBadgeStatus {
  if (isActiveConnection(connection)) return "completed";
  if (connection?.status === "reauth_required") return "pending";
  return "disabled";
}

export function safeProviderMetadata(input: {
  email: string;
  planType: string;
}): ProviderConnectionMetadata {
  const metadata: { email?: string; planType?: string } = {};
  const email = input.email.trim();
  const planType = input.planType.trim();
  if (email) metadata.email = email;
  if (planType) metadata.planType = planType;
  return metadata;
}

export function safeExternalAuthUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function codexLoginUrl(login: CodexChatGptLogin | null): string | null {
  if (!login) return null;
  return safeExternalAuthUrl(login.type === "chatgpt" ? login.authUrl : login.verificationUrl);
}

export function codexAccountLabel(
  status: CodexChatGptStatus | null,
  connection: ProviderConnectionMeta | null,
): string {
  return (
    status?.account?.email ??
    connection?.metadata.email ??
    status?.account?.planType ??
    connection?.metadata.planType ??
    "No ChatGPT account connected"
  );
}

export function codexAuthStatusLabel(
  status: CodexChatGptStatus | null,
  connection: ProviderConnectionMeta | null,
): string {
  if (connection?.status === "connected" || status?.account?.authMode === "chatgpt") {
    return "Connected";
  }
  if (connection?.status === "reauth_required" || status?.requiresOpenaiAuth) {
    return "Reauth required";
  }
  if (connection?.status === "revoked") return "Revoked";
  return "Not connected";
}

/** The quiet-tone mapping for the ChatGPT connection chip, mirroring
 *  codexAuthStatusLabel so label and tone never diverge. */
export function codexAuthBadgeStatus(
  status: CodexChatGptStatus | null,
  connection: ProviderConnectionMeta | null,
): ConnectionBadgeStatus {
  if (isActiveConnection(connection) || status?.account?.authMode === "chatgpt") return "completed";
  if (connection?.status === "reauth_required" || status?.requiresOpenaiAuth) return "pending";
  return "disabled";
}
