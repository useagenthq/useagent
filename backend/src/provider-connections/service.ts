import { openSecret, sealSecret } from "../secrets/crypto";
import {
  findProviderConnection,
  listProviderConnections,
  revokeProviderConnection,
  upsertProviderConnection,
  type ProviderConnectionRecord,
  type ProviderConnectionScope,
} from "./repo";
import {
  assertTrustedOAuthBundle,
  type ProviderConnectionCredential,
  type ProviderConnectionMetadata,
  type TrustedChatGptOAuthBundle,
} from "./types";
import type {
  ProviderConnectionAuthMethod,
  ProviderConnectionProvider,
  ProviderConnectionStatus,
} from "../db/schema";

export interface ProviderConnectionMeta {
  id: string;
  provider: ProviderConnectionProvider;
  authMethod: ProviderConnectionAuthMethod;
  status: ProviderConnectionStatus;
  metadata: ProviderConnectionMetadata;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

function toMeta(row: ProviderConnectionRecord): ProviderConnectionMeta {
  return {
    id: row.id,
    provider: row.provider,
    authMethod: row.authMethod,
    status: row.status,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

function sealCredential(credential: ProviderConnectionCredential) {
  return sealSecret(JSON.stringify(credential));
}

function openCredential(row: ProviderConnectionRecord): ProviderConnectionCredential {
  const parsed = JSON.parse(
    openSecret({
      ciphertext: row.credentialCiphertext,
      iv: row.iv,
      tag: row.tag,
    }),
  ) as ProviderConnectionCredential;
  return parsed;
}

export async function listCurrentUserProviderConnections(
  scope: ProviderConnectionScope,
): Promise<ProviderConnectionMeta[]> {
  return (await listProviderConnections(scope)).map(toMeta);
}

export async function getCurrentUserProviderConnection(
  scope: ProviderConnectionScope & {
    provider: ProviderConnectionProvider;
    authMethod?: ProviderConnectionAuthMethod;
  },
): Promise<ProviderConnectionMeta | null> {
  const row = await findProviderConnection(scope);
  return row ? toMeta(row) : null;
}

export async function upsertApiKeyProviderConnection(
  scope: ProviderConnectionScope & {
    provider: ProviderConnectionProvider;
    apiKey: string;
    metadata: ProviderConnectionMetadata;
  },
): Promise<ProviderConnectionMeta> {
  const sealed = sealCredential({ authMethod: "api_key", value: scope.apiKey });
  const row = await upsertProviderConnection({
    ...scope,
    authMethod: "api_key",
    status: "connected",
    credentialCiphertext: sealed.ciphertext,
    iv: sealed.iv,
    tag: sealed.tag,
  });
  return toMeta(row);
}

/**
 * Internal/service-only OAuth storage. Browser routes intentionally do not call
 * this because a raw OAuth bundle is trusted credential material that must come
 * from a server-side OAuth callback/device-flow worker.
 */
export async function storeTrustedChatGptOAuthProviderConnection(
  scope: ProviderConnectionScope & {
    provider: ProviderConnectionProvider;
    bundle: TrustedChatGptOAuthBundle;
    metadata: ProviderConnectionMetadata;
  },
): Promise<ProviderConnectionMeta> {
  const bundle = assertTrustedOAuthBundle(scope.bundle);
  const sealed = sealCredential({ authMethod: "chatgpt_oauth", value: bundle });
  const row = await upsertProviderConnection({
    ...scope,
    authMethod: "chatgpt_oauth",
    status: "connected",
    credentialCiphertext: sealed.ciphertext,
    iv: sealed.iv,
    tag: sealed.tag,
  });
  return toMeta(row);
}

export async function revokeCurrentUserProviderConnection(
  scope: ProviderConnectionScope & {
    provider: ProviderConnectionProvider;
    authMethod?: ProviderConnectionAuthMethod;
  },
): Promise<ProviderConnectionMeta | null> {
  const row = await revokeProviderConnection(scope);
  return row ? toMeta(row) : null;
}

/**
 * Trusted backend retrieval for runtime integration. Returns plaintext only for
 * the exact user/org/provider scope and only while the connection is connected.
 * HTTP routes never expose this value.
 */
export async function getTrustedProviderCredential(
  scope: ProviderConnectionScope & {
    provider: ProviderConnectionProvider;
    authMethod?: ProviderConnectionAuthMethod;
  },
): Promise<ProviderConnectionCredential | null> {
  const row = await findProviderConnection(scope);
  if (!row || row.status !== "connected") return null;
  return openCredential(row);
}
