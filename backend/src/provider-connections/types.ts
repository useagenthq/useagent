import {
  PROVIDER_CONNECTION_AUTH_METHODS,
  PROVIDER_CONNECTION_PROVIDERS,
  type ProviderConnectionAuthMethod,
  type ProviderConnectionMetadata,
  type ProviderConnectionProvider,
} from "../db/schema";

export type { ProviderConnectionMetadata };

export interface ProviderConnectionCredential {
  authMethod: ProviderConnectionAuthMethod;
  value: string | TrustedChatGptOAuthBundle;
}

export interface TrustedChatGptOAuthBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
}

export function isProviderConnectionProvider(
  value: string,
): value is ProviderConnectionProvider {
  return (PROVIDER_CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

export function isProviderConnectionAuthMethod(
  value: string,
): value is ProviderConnectionAuthMethod {
  return (PROVIDER_CONNECTION_AUTH_METHODS as readonly string[]).includes(value);
}

export function readSafeMetadata(value: unknown): ProviderConnectionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const metadata: ProviderConnectionMetadata = {};
  if (typeof input.email === "string" && input.email.trim()) {
    metadata.email = input.email.trim();
  }
  if (typeof input.planType === "string" && input.planType.trim()) {
    metadata.planType = input.planType.trim();
  }
  return metadata;
}

export function assertTrustedOAuthBundle(
  value: TrustedChatGptOAuthBundle,
): TrustedChatGptOAuthBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("oauth bundle must be an object");
  }
  if (typeof value.accessToken !== "string" || value.accessToken.length === 0) {
    throw new Error("oauth bundle accessToken is required");
  }
  if (value.refreshToken !== undefined && typeof value.refreshToken !== "string") {
    throw new Error("oauth bundle refreshToken must be a string");
  }
  if (value.expiresAt !== undefined && typeof value.expiresAt !== "string") {
    throw new Error("oauth bundle expiresAt must be a string");
  }
  if (value.scope !== undefined && typeof value.scope !== "string") {
    throw new Error("oauth bundle scope must be a string");
  }
  return value;
}
