import { decryptOrgSecretByName } from "../secrets/store";
import { runtimeDevModeEnabled } from "../security/runtime-secrets";
import { resolveGatewayProviderApiKeyCredential } from "./api-key-credentials";
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

/**
 * Resolve one provider credential for a concrete run. User-owned API keys win
 * over tenant keys so a connected account can spend its own provider quota
 * without exposing that key to the sandbox. ChatGPT OAuth bundles are
 * intentionally not returned here: the provider gateway talks to public API
 * endpoints, while subscription-backed Codex auth must go through a trusted
 * Codex broker/app-server path.
 */
export async function resolveProviderCredentialForRun(input: {
  orgId: string;
  userId?: string | null;
  provider: ProviderId;
}): Promise<string | null> {
  if (input.userId) {
    const userCredential = await resolveGatewayProviderApiKeyCredential({
      orgId: input.orgId,
      userId: input.userId,
      provider: input.provider,
    });
    if (userCredential) return userCredential;
  }
  return resolveProviderCredential(input.orgId, input.provider);
}
