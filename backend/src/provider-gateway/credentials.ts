import { decryptOrgSecretByName } from "../secrets/store";
import { runtimeDevModeEnabled } from "../security/runtime-secrets";
import { providerCredentialName, type ProviderId } from "./provider";

/** Resolve one provider credential in the trusted backend, tenant first. */
export async function resolveProviderCredential(
  orgId: string,
  provider: ProviderId,
): Promise<string | null> {
  const name = providerCredentialName(provider);
  const tenantValue = (await decryptOrgSecretByName(orgId, name))?.value.trim();
  if (tenantValue) return tenantValue;
  // Shared operator credentials are a local-development convenience only. A
  // production org without its own provider secret fails closed instead of
  // spending another tenant's/shared account.
  if (!runtimeDevModeEnabled()) return null;
  return process.env[name]?.trim() || null;
}
