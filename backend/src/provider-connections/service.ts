import { createHash } from "node:crypto";
import type { ProviderConnectionAuthMethod, ProviderConnectionProvider } from "../db/schema";
import { publishOrgChange } from "../runs/org-signals";
import { openSecret, sealSecret } from "../secrets/crypto";
import {
  findProviderConnection,
  listProviderConnections,
  type ProviderConnectionRecord,
  type ProviderConnectionScope,
  revokeProviderConnection,
  upsertProviderConnection,
  upsertProviderConnectionUnlessRevoked,
} from "./repo";
import {
  assertManagedCodexAppServerSession,
  assertTrustedOAuthBundle,
  type ManagedCodexAppServerSession,
  type ProviderConnectionChangeAction,
  type ProviderConnectionCredential,
  type ProviderConnectionMeta,
  type ProviderConnectionMetadata,
  type TrustedChatGptOAuthBundle,
} from "./types";

export type { ProviderConnectionMeta } from "./types";

export interface CodexSubscriptionAuth {
  accessToken: string;
  accountId: string;
  planType: string;
  expiresAt: string | null;
}

export interface CodexSubscriptionRuntimeSelection {
  authMethod: "chatgpt_oauth";
  mode: "managed_codex_app_server";
  connectionId: string;
  authEpoch: string;
  codexHome: string;
  metadata: ProviderConnectionMetadata;
}

function credentialEpoch(row: ProviderConnectionRecord): string {
  return createHash("sha256")
    .update(row.credentialCiphertext)
    .update("\0")
    .update(row.iv)
    .update("\0")
    .update(row.tag)
    .digest("hex");
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

function publishProviderConnectionChange(
  row: ProviderConnectionRecord,
  action: ProviderConnectionChangeAction,
): void {
  publishOrgChange(row.orgId, {
    type: "provider_connection",
    action,
    targetUserId: row.userId,
    connectionId: row.id,
    provider: row.provider,
    authMethod: row.authMethod,
    status: row.status,
  });
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

function sameProviderMetadata(
  left: ProviderConnectionMetadata,
  right: ProviderConnectionMetadata,
): boolean {
  return left.email === right.email && left.planType === right.planType;
}

function sameManagedCodexSession(
  left: ManagedCodexAppServerSession,
  right: ManagedCodexAppServerSession,
): boolean {
  return left.codexHome === right.codexHome &&
    left.email === right.email &&
    left.planType === right.planType;
}

const managedCodexSessionWriteTails = new Map<string, Promise<void>>();

async function serializeManagedCodexSessionWrite<T>(
  scope: ProviderConnectionScope & { provider: "openai" },
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${scope.orgId}\0${scope.userId}\0${scope.provider}`;
  const previous = managedCodexSessionWriteTails.get(key) ?? Promise.resolve();
  const { promise: finished, resolve } = Promise.withResolvers<void>();
  const tail = (async () => {
    await previous;
    await finished;
  })();
  managedCodexSessionWriteTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    resolve();
    if (managedCodexSessionWriteTails.get(key) === tail) {
      managedCodexSessionWriteTails.delete(key);
    }
  }
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
  publishProviderConnectionChange(row, "updated");
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
  publishProviderConnectionChange(row, "updated");
  return toMeta(row);
}

export async function storeManagedCodexAppServerProviderConnection(
  scope: ProviderConnectionScope & {
    provider?: "openai";
    session: ManagedCodexAppServerSession;
    metadata: ProviderConnectionMetadata;
    allowReconnect?: boolean;
  },
): Promise<ProviderConnectionMeta> {
  const session = assertManagedCodexAppServerSession(scope.session);
  const provider = scope.provider ?? "openai";
  return serializeManagedCodexSessionWrite(
    { orgId: scope.orgId, userId: scope.userId, provider },
    async () => {
      const existing = await findProviderConnection({
        ...scope,
        provider,
        authMethod: "chatgpt_oauth",
      });
      if (existing?.status === "connected") {
        const credential = openCredential(existing);
        if (
          credential.authMethod === "chatgpt_oauth" &&
          typeof credential.value !== "string" &&
          "type" in credential.value &&
          credential.value.type === "managed_codex_app_server" &&
          sameManagedCodexSession(assertManagedCodexAppServerSession(credential.value), session) &&
          sameProviderMetadata(existing.metadata, scope.metadata)
        ) {
          return toMeta(existing);
        }
      }
      const sealed = sealCredential({ authMethod: "chatgpt_oauth", value: session });
      const connectionInput = {
        ...scope,
        provider,
        authMethod: "chatgpt_oauth",
        status: "connected",
        metadata: scope.metadata,
        credentialCiphertext: sealed.ciphertext,
        iv: sealed.iv,
        tag: sealed.tag,
      } as const;
      // The conservative sync path (allowReconnect false) exists so a stale
      // pre-logout status snapshot cannot resurrect a deliberately revoked row.
      // A live account under a DIFFERENT email than the revoked row cannot be
      // that stale snapshot - it is a genuinely new login whose completion
      // notification was lost, so reconcile instead of stranding the row.
      const revokedRowForOtherAccount =
        existing?.status === "revoked" &&
        typeof existing.metadata?.email === "string" &&
        typeof scope.metadata.email === "string" &&
        existing.metadata.email !== scope.metadata.email;
      const row = scope.allowReconnect === false && !revokedRowForOtherAccount
        ? await upsertProviderConnectionUnlessRevoked(connectionInput)
        : await upsertProviderConnection(connectionInput);
      if (!row) {
        const current = await findProviderConnection({
          ...scope,
          provider,
          authMethod: "chatgpt_oauth",
        });
        if (!current) throw new Error("provider connection conditional upsert returned no row");
        return toMeta(current);
      }
      publishProviderConnectionChange(row, "updated");
      return toMeta(row);
    },
  );
}

export async function revokeCurrentUserProviderConnection(
  scope: ProviderConnectionScope & {
    provider: ProviderConnectionProvider;
    authMethod?: ProviderConnectionAuthMethod;
  },
): Promise<ProviderConnectionMeta | null> {
  const row = await revokeProviderConnection(scope);
  if (row) publishProviderConnectionChange(row, "revoked");
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

export async function getTrustedCodexSubscriptionAuth(
  scope: ProviderConnectionScope & {
    provider?: "openai";
  },
): Promise<CodexSubscriptionAuth | null> {
  const row = await findProviderConnection({
    ...scope,
    provider: scope.provider ?? "openai",
    authMethod: "chatgpt_oauth",
  });
  if (!row || row.status !== "connected") return null;
  const credential = openCredential(row);
  if (
    credential.authMethod !== "chatgpt_oauth" ||
    typeof credential.value === "string" ||
    "type" in credential.value && credential.value.type === "managed_codex_app_server"
  ) {
    return null;
  }
  const bundle = assertTrustedOAuthBundle(credential.value);
  if (bundle.expiresAt && Number.isNaN(Date.parse(bundle.expiresAt))) {
    return null;
  }
  return {
    accessToken: bundle.accessToken,
    accountId: bundle.accountId,
    planType: bundle.planType,
    expiresAt: bundle.expiresAt ?? null,
  };
}

export async function getCodexSubscriptionRuntimeSelection(
  scope: ProviderConnectionScope & {
    provider?: "openai";
  },
): Promise<CodexSubscriptionRuntimeSelection | null> {
  const row = await findProviderConnection({
    ...scope,
    provider: scope.provider ?? "openai",
    authMethod: "chatgpt_oauth",
  });
  if (!row || row.status !== "connected") return null;
  const credential = openCredential(row);
  if (
    credential.authMethod !== "chatgpt_oauth" ||
    typeof credential.value === "string" ||
    !("type" in credential.value) ||
    credential.value.type !== "managed_codex_app_server"
  ) {
    return null;
  }
  const session = assertManagedCodexAppServerSession(credential.value);
  return {
    authMethod: "chatgpt_oauth",
    mode: "managed_codex_app_server",
    connectionId: row.id,
    authEpoch: credentialEpoch(row),
    codexHome: session.codexHome,
    metadata: row.metadata,
  };
}
