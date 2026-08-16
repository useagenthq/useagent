import type {
  ProviderConnectionAuthMethod,
  ProviderConnectionChangeAction,
  ProviderConnectionMeta,
  ProviderConnectionMetadata,
  ProviderConnectionProvider,
} from "@skynet/agent-client/provider-connections";

export {
  decodeProviderConnectionMetadata as readSafeMetadata,
  isProviderConnectionAuthMethod,
  isProviderConnectionProvider,
} from "@skynet/agent-client/provider-connections";
export type {
  ProviderConnectionAuthMethod,
  ProviderConnectionChangeAction,
  ProviderConnectionMeta,
  ProviderConnectionMetadata,
  ProviderConnectionProvider,
};

export interface ProviderConnectionCredential {
  authMethod: ProviderConnectionAuthMethod;
  value: string | TrustedChatGptOAuthBundle | ManagedCodexAppServerSession;
}

export interface TrustedChatGptOAuthBundle {
  type?: "oauth_bundle";
  accessToken: string;
  accountId: string;
  planType: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
}

export interface ManagedCodexAppServerSession {
  type: "managed_codex_app_server";
  codexHome: string;
  email?: string;
  planType?: string;
  connectedAt: string;
}

export function assertTrustedOAuthBundle(
  value: unknown,
): TrustedChatGptOAuthBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("oauth bundle must be an object");
  }
  const bundle = value as TrustedChatGptOAuthBundle;
  if (typeof bundle.accessToken !== "string" || bundle.accessToken.length === 0) {
    throw new Error("oauth bundle accessToken is required");
  }
  if (typeof bundle.accountId !== "string" || bundle.accountId.length === 0) {
    throw new Error("oauth bundle accountId is required");
  }
  if (typeof bundle.planType !== "string" || bundle.planType.length === 0) {
    throw new Error("oauth bundle planType is required");
  }
  if (bundle.refreshToken !== undefined && typeof bundle.refreshToken !== "string") {
    throw new Error("oauth bundle refreshToken must be a string");
  }
  if (bundle.expiresAt !== undefined && typeof bundle.expiresAt !== "string") {
    throw new Error("oauth bundle expiresAt must be a string");
  }
  if (bundle.scope !== undefined && typeof bundle.scope !== "string") {
    throw new Error("oauth bundle scope must be a string");
  }
  return bundle;
}

export function assertManagedCodexAppServerSession(
  value: unknown,
): ManagedCodexAppServerSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("managed Codex session must be an object");
  }
  const session = value as ManagedCodexAppServerSession;
  if (session.type !== "managed_codex_app_server") {
    throw new Error("managed Codex session type is required");
  }
  if (typeof session.codexHome !== "string" || session.codexHome.length === 0) {
    throw new Error("managed Codex session codexHome is required");
  }
  if (session.email !== undefined && typeof session.email !== "string") {
    throw new Error("managed Codex session email must be a string");
  }
  if (session.planType !== undefined && typeof session.planType !== "string") {
    throw new Error("managed Codex session planType must be a string");
  }
  if (typeof session.connectedAt !== "string" || Number.isNaN(Date.parse(session.connectedAt))) {
    throw new Error("managed Codex session connectedAt is required");
  }
  return session;
}
