import { describe, expect, test } from "bun:test";
import { providerRequestLimits } from "./limits";
import { ANTHROPIC_ENGINE_OUTPUT_TOKENS } from "./sandbox-config";

describe("provider request limits", () => {
  test("uses bounded defaults when environment values are unsafe", () => {
    const resolved = providerRequestLimits({
      PROVIDER_GATEWAY_MAX_REQUESTS_PER_RUN: "-1",
      PROVIDER_GATEWAY_MAX_CONCURRENT_PER_RUN: "999",
      PROVIDER_GATEWAY_MAX_OUTPUT_TOKENS: "Infinity",
      PROVIDER_GATEWAY_UPSTREAM_TIMEOUT_MS: "999999999",
    });
    expect(resolved).toEqual({
      maxRequestsPerRun: Number.POSITIVE_INFINITY,
      maxConcurrentPerRun: 4,
      maxOutputTokens: 65_536,
      upstreamTimeoutMs: 600_000,
    });
  });

  test("the default output ceiling takes the most output an engine asks an Anthropic model for", () => {
    expect(providerRequestLimits({}).maxOutputTokens).toBeGreaterThanOrEqual(ANTHROPIC_ENGINE_OUTPUT_TOKENS);
  });

  test("caps requests per run only when the operator sets one", () => {
    expect(providerRequestLimits({}).maxRequestsPerRun).toBe(Number.POSITIVE_INFINITY);
    expect(providerRequestLimits({ PROVIDER_GATEWAY_MAX_REQUESTS_PER_RUN: "500" }).maxRequestsPerRun).toBe(500);
  });
});
