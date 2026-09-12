import { client } from "../db/client";
import type {
  ProviderConnectionMetadata,
  ProviderConnectionProvider,
} from "../db/schema";
import { openSecret } from "../secrets/crypto";
import type { ProviderId } from "./provider";

export interface GatewayProviderApiKeyCredentialRow {
  readonly auth_method: string;
  readonly status: string;
  readonly credential_ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

interface GatewayComputerApiKeyCredentialRow
  extends GatewayProviderApiKeyCredentialRow {
  readonly provider: ProviderConnectionProvider;
  readonly metadata: ProviderConnectionMetadata;
}

export interface GatewayComputerApiKeyConnection {
  readonly provider: ProviderConnectionProvider;
  readonly value: string;
  readonly metadata: ProviderConnectionMetadata;
}

export function openGatewayProviderApiKeyCredential(
  row: GatewayProviderApiKeyCredentialRow,
): string | null {
  if (row.auth_method !== "api_key" || row.status !== "connected") return null;
  try {
    const credential = JSON.parse(
      openSecret({
        ciphertext: row.credential_ciphertext,
        iv: row.iv,
        tag: row.tag,
      }),
    ) as unknown;
    if (
      !credential ||
      typeof credential !== "object" ||
      Array.isArray(credential) ||
      !("authMethod" in credential) ||
      credential.authMethod !== "api_key" ||
      !("value" in credential) ||
      typeof credential.value !== "string"
    ) {
      return null;
    }
    return credential.value.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveGatewayProviderApiKeyCredential(input: {
  readonly orgId: string;
  readonly userId: string;
  readonly provider: ProviderId;
}): Promise<string | null> {
  const rows = await client<GatewayProviderApiKeyCredentialRow[]>`
    SELECT auth_method, status, credential_ciphertext, iv, tag
    FROM gateway_provider_api_key_credentials
    WHERE org_id = ${input.orgId}
      AND user_id = ${input.userId}
      AND provider = ${input.provider}
      AND auth_method = 'api_key'
      AND status = 'connected'
    LIMIT 1
  `;
  const row = rows[0];
  return row ? openGatewayProviderApiKeyCredential(row) : null;
}

/** Resolve the most recently updated connected computer credential through the
 * restricted API-key view. The gateway never reads the underlying table
 * directly; metadata is non-secret and the credential remains sealed until
 * this exact org/user lookup succeeds. */
export async function resolveGatewayComputerApiKeyConnection(input: {
  readonly orgId: string;
  readonly userId: string;
  readonly providers: readonly ProviderConnectionProvider[];
}): Promise<GatewayComputerApiKeyConnection | null> {
  if (input.providers.length === 0) return null;
  const rows = await client<GatewayComputerApiKeyCredentialRow[]>`
    SELECT provider, auth_method, status, credential_ciphertext, iv, tag, metadata
    FROM gateway_provider_api_key_credentials
    WHERE org_id = ${input.orgId}
      AND user_id = ${input.userId}
      AND provider = ANY(${[...input.providers]})
      AND auth_method = 'api_key'
      AND status = 'connected'
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const value = openGatewayProviderApiKeyCredential(row);
  return value
    ? { provider: row.provider, value, metadata: row.metadata ?? {} }
    : null;
}
