/** Browser-safe provider-connection API and realtime wire contract. */

export const PROVIDER_CONNECTION_PROVIDERS = ["openai", "anthropic", "openrouter"] as const;
export type ProviderConnectionProvider = (typeof PROVIDER_CONNECTION_PROVIDERS)[number];

export const PROVIDER_CONNECTION_AUTH_METHODS = ["chatgpt_oauth", "api_key"] as const;
export type ProviderConnectionAuthMethod = (typeof PROVIDER_CONNECTION_AUTH_METHODS)[number];

export const PROVIDER_CONNECTION_STATUSES = ["connected", "reauth_required", "revoked"] as const;
export type ProviderConnectionStatus = (typeof PROVIDER_CONNECTION_STATUSES)[number];

export const PROVIDER_CONNECTION_CHANGE_ACTIONS = ["updated", "revoked"] as const;
export type ProviderConnectionChangeAction = (typeof PROVIDER_CONNECTION_CHANGE_ACTIONS)[number];

export interface ProviderConnectionMetadata {
  readonly email?: string;
  readonly planType?: string;
}

export interface ProviderConnectionMeta {
  readonly id: string;
  readonly provider: ProviderConnectionProvider;
  readonly authMethod: ProviderConnectionAuthMethod;
  readonly status: ProviderConnectionStatus;
  readonly metadata: ProviderConnectionMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
}

export interface ProviderConnectionChange {
  readonly type: "provider_connection";
  readonly action: ProviderConnectionChangeAction;
  readonly provider: ProviderConnectionProvider;
  readonly authMethod: ProviderConnectionAuthMethod;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProviderConnectionProvider(value: unknown): value is ProviderConnectionProvider {
  return (
    typeof value === "string" &&
    (PROVIDER_CONNECTION_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isProviderConnectionAuthMethod(
  value: unknown,
): value is ProviderConnectionAuthMethod {
  return (
    typeof value === "string" &&
    (PROVIDER_CONNECTION_AUTH_METHODS as readonly string[]).includes(value)
  );
}

export function isProviderConnectionStatus(value: unknown): value is ProviderConnectionStatus {
  return (
    typeof value === "string" && (PROVIDER_CONNECTION_STATUSES as readonly string[]).includes(value)
  );
}

function isProviderConnectionChangeAction(value: unknown): value is ProviderConnectionChangeAction {
  return (
    typeof value === "string" &&
    (PROVIDER_CONNECTION_CHANGE_ACTIONS as readonly string[]).includes(value)
  );
}

export function decodeProviderConnectionMetadata(value: unknown): ProviderConnectionMetadata {
  if (!isRecord(value)) return {};
  const metadata: { email?: string; planType?: string } = {};
  if (typeof value.email === "string" && value.email.trim()) {
    metadata.email = value.email.trim();
  }
  if (typeof value.planType === "string" && value.planType.trim()) {
    metadata.planType = value.planType.trim();
  }
  return metadata;
}

export function decodeProviderConnectionMeta(value: unknown): ProviderConnectionMeta | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isProviderConnectionProvider(value.provider) ||
    !isProviderConnectionAuthMethod(value.authMethod) ||
    !isProviderConnectionStatus(value.status) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.revokedAt !== null && typeof value.revokedAt !== "string")
  ) {
    return null;
  }
  return {
    id: value.id,
    provider: value.provider,
    authMethod: value.authMethod,
    status: value.status,
    metadata: decodeProviderConnectionMetadata(value.metadata),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    revokedAt: value.revokedAt,
  };
}

export function decodeProviderConnections(value: unknown): ProviderConnectionMeta[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(decodeProviderConnectionMeta)
    .filter((connection): connection is ProviderConnectionMeta => connection !== null);
}

export function decodeProviderConnectionChange(value: unknown): ProviderConnectionChange | null {
  if (
    !isRecord(value) ||
    value.type !== "provider_connection" ||
    !isProviderConnectionChangeAction(value.action) ||
    !isProviderConnectionProvider(value.provider) ||
    !isProviderConnectionAuthMethod(value.authMethod)
  ) {
    return null;
  }
  return {
    type: value.type,
    action: value.action,
    provider: value.provider,
    authMethod: value.authMethod,
  };
}
