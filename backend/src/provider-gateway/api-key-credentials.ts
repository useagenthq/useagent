import { client } from "../db/client";
import { openSecret } from "../secrets/crypto";
import type { ProviderId } from "./provider";

export interface GatewayProviderApiKeyCredentialRow {
  readonly auth_method: string;
  readonly status: string;
  readonly credential_ciphertext: string;
  readonly iv: string;
  readonly tag: string;
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
