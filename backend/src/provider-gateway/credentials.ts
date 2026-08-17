import { decryptOrgSecretByName } from "../secrets/store";
import { runtimeDevModeEnabled } from "../security/runtime-secrets";
import { resolveGatewayProviderApiKeyCredential } from "./api-key-credentials";
import { providerCredentialName, type ProviderId } from "./provider";

/**
 * Which identity's key served a provider request. This is a non-secret LABEL
 * only - never key material - so it is safe to log and to attribute usage by.
 */
export type ProviderCredentialSource =
  | "user_connection" // a customer's connected BYO API key (provider_connections)
  | "org_secret" // an org-level provider secret (org secrets store)
  | "backend_env"; // the shared house/operator key from process.env

export interface ResolvedProviderCredential {
  readonly value: string;
  readonly source: ProviderCredentialSource;
}

/**
 * Injectable seams so the resolution precedence can be unit-tested without a
 * database. Production callers pass nothing and get the real DB/env resolvers.
 */
export interface ProviderCredentialResolvers {
  readonly resolveUserConnection?: typeof resolveGatewayProviderApiKeyCredential;
  readonly resolveOrgSecret?: (orgId: string, name: string) => Promise<string | null>;
  readonly env?: Record<string, string | undefined>;
  readonly devModeEnabled?: (env?: Record<string, string | undefined>) => boolean;
}

async function defaultOrgSecret(orgId: string, name: string): Promise<string | null> {
  return (await decryptOrgSecretByName(orgId, name))?.value ?? null;
}

/**
 * Resolve one provider credential in the trusted backend, tenant first. Returns
 * the winning key AND its non-secret provenance so the caller can record which
 * identity served the request. Shared operator (env) credentials are a
 * local-development convenience only: a production org without its own provider
 * secret fails closed rather than spend another tenant's/shared account.
 */
export async function resolveProviderCredential(
  orgId: string,
  provider: ProviderId,
  deps: ProviderCredentialResolvers = {},
): Promise<ResolvedProviderCredential | null> {
  const resolveOrgSecret = deps.resolveOrgSecret ?? defaultOrgSecret;
  const env = deps.env ?? process.env;
  const devModeEnabled = deps.devModeEnabled ?? runtimeDevModeEnabled;
  const name = providerCredentialName(provider);
  const tenantValue = (await resolveOrgSecret(orgId, name))?.trim();
  if (tenantValue) return { value: tenantValue, source: "org_secret" };
  if (!devModeEnabled(env)) return null;
  const houseKey = env[name]?.trim();
  return houseKey ? { value: houseKey, source: "backend_env" } : null;
}

/**
 * Resolve one provider credential for a concrete run. THIS is the single
 * resolution point for sandboxed engine runs; no other place picks a run's
 * provider key. Precedence: a customer's connected BYO API key wins over the
 * tenant/org secret, which wins over the shared house key - so a connected
 * account spends its own provider quota without ever exposing that key to the
 * sandbox. A resolved key is used as-is: an invalid customer key surfaces the
 * provider's real error to the run (proxied back by the gateway) instead of
 * silently re-billing the house. ChatGPT OAuth bundles are intentionally not
 * returned here: the provider gateway talks to public API endpoints, while
 * subscription-backed Codex auth must go through a trusted Codex broker path.
 */
export async function resolveProviderCredentialForRun(
  input: {
    orgId: string;
    userId?: string | null;
    provider: ProviderId;
  },
  deps: ProviderCredentialResolvers = {},
): Promise<ResolvedProviderCredential | null> {
  const resolveUserConnection = deps.resolveUserConnection ?? resolveGatewayProviderApiKeyCredential;
  if (input.userId) {
    const userCredential = await resolveUserConnection({
      orgId: input.orgId,
      userId: input.userId,
      provider: input.provider,
    });
    if (userCredential) return { value: userCredential, source: "user_connection" };
  }
  return resolveProviderCredential(input.orgId, input.provider, deps);
}

/**
 * Resolve the OpenRouter credential for the lightweight Chat surface (#122) and
 * the `chat` engine. A customer's connected BYO key wins so their own quota is
 * spent; otherwise the shared house key serves. Unlike a sandboxed run, chat is
 * the instant house-provided tier, so falling back to the house key is an
 * EXPLICIT, documented contract - not a silent substitution. Once a customer key
 * is chosen it is the only key used: an invalid customer key surfaces the real
 * OpenRouter error to the caller instead of quietly re-billing the house.
 */
export async function resolveChatProviderCredential(
  input: { orgId: string; userId?: string | null },
  deps: ProviderCredentialResolvers = {},
): Promise<ResolvedProviderCredential | null> {
  const resolveUserConnection = deps.resolveUserConnection ?? resolveGatewayProviderApiKeyCredential;
  const env = deps.env ?? process.env;
  if (input.userId) {
    const userCredential = await resolveUserConnection({
      orgId: input.orgId,
      userId: input.userId,
      provider: "openrouter",
    });
    if (userCredential) return { value: userCredential, source: "user_connection" };
  }
  const houseKey = env.OPENROUTER_API_KEY?.trim();
  return houseKey ? { value: houseKey, source: "backend_env" } : null;
}
