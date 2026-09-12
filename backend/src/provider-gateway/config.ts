import {
  assertGatewayCapabilitySecret,
  validateGatewayPublicUrl,
} from "../security/gateway-boundary";
import { errorMessage } from "../util/error-message";

export const PROVIDER_GATEWAY_PATH = "/api/provider";

// The worker's absolute run ceiling defaults to four hours. A short grace keeps
// slow teardown reliable without creating a multi-day replay credential.
const DEFAULT_TOKEN_TTL_MS = 4 * 60 * 60 * 1000 + 15 * 60 * 1000;
const MAX_TOKEN_TTL_MS = 5 * 60 * 60 * 1000;

export interface ProviderGatewayConfig {
  readonly publicUrl: string;
  readonly tokenTtlMs: number;
}

/**
 * Why sandbox engines cannot reach a provider gateway, or null when the wiring
 * is complete. Readiness reports this so a missing GATEWAY_PUBLIC_URL shows up
 * in the picker and refuses the run at acceptance instead of failing it a
 * second later inside the adapter.
 */
export function providerGatewayProblem(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const rawPublicUrl = (env.PROVIDER_GATEWAY_PUBLIC_URL ?? env.GATEWAY_PUBLIC_URL)?.trim();
  if (!rawPublicUrl) return "GATEWAY_PUBLIC_URL is not set";
  try {
    validateGatewayPublicUrl(rawPublicUrl, env);
    assertGatewayCapabilitySecret("PROVIDER_GATEWAY_SECRET", env);
  } catch (error) {
    return errorMessage(error);
  }
  return null;
}

/**
 * Public origin of the gateway-only service. The generic origin keeps knowledge
 * and provider traffic on one narrow ingress. TOOL_GATEWAY_PUBLIC_URL is
 * intentionally not accepted: historically it pointed at the full backend.
 */
export function providerGatewayConfig(): ProviderGatewayConfig | null {
  const rawPublicUrl = (
    process.env.PROVIDER_GATEWAY_PUBLIC_URL ??
    process.env.GATEWAY_PUBLIC_URL
  )
    ?.trim()
    .replace(/\/+$/, "");
  if (!rawPublicUrl) return null;
  const publicUrl = validateGatewayPublicUrl(rawPublicUrl);
  assertGatewayCapabilitySecret("PROVIDER_GATEWAY_SECRET");
  const rawTtl = Number(process.env.PROVIDER_GATEWAY_TOKEN_TTL_MS);
  const tokenTtlMs =
    Number.isFinite(rawTtl) && rawTtl > 0 && rawTtl <= MAX_TOKEN_TTL_MS
      ? rawTtl
      : DEFAULT_TOKEN_TTL_MS;
  return { publicUrl, tokenTtlMs };
}
