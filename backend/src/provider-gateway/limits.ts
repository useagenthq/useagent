export interface ProviderRequestLimits {
  readonly maxRequestsPerRun: number;
  readonly maxConcurrentPerRun: number;
  readonly maxOutputTokens: number;
  readonly upstreamTimeoutMs: number;
}

const DEFAULT_LIMITS: ProviderRequestLimits = {
  maxRequestsPerRun: 256,
  maxConcurrentPerRun: 4,
  maxOutputTokens: 65_536,
  upstreamTimeoutMs: 10 * 60 * 1000,
};

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

export function providerRequestLimits(
  env: Record<string, string | undefined> = process.env,
): ProviderRequestLimits {
  return {
    maxRequestsPerRun: boundedInteger(
      env.PROVIDER_GATEWAY_MAX_REQUESTS_PER_RUN,
      DEFAULT_LIMITS.maxRequestsPerRun,
      10_000,
    ),
    maxConcurrentPerRun: boundedInteger(
      env.PROVIDER_GATEWAY_MAX_CONCURRENT_PER_RUN,
      DEFAULT_LIMITS.maxConcurrentPerRun,
      32,
    ),
    maxOutputTokens: boundedInteger(
      env.PROVIDER_GATEWAY_MAX_OUTPUT_TOKENS,
      DEFAULT_LIMITS.maxOutputTokens,
      1_000_000,
    ),
    upstreamTimeoutMs: boundedInteger(
      env.PROVIDER_GATEWAY_UPSTREAM_TIMEOUT_MS,
      DEFAULT_LIMITS.upstreamTimeoutMs,
      30 * 60 * 1000,
    ),
  };
}
