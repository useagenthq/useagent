import { describe, expect, test } from "bun:test";
import { providerRequestLimits } from "./limits";

describe("provider request limits", () => {
  test("uses bounded defaults when environment values are unsafe", () => {
    const resolved = providerRequestLimits({
      PROVIDER_GATEWAY_MAX_REQUESTS_PER_RUN: "-1",
      PROVIDER_GATEWAY_MAX_CONCURRENT_PER_RUN: "999",
      PROVIDER_GATEWAY_MAX_OUTPUT_TOKENS: "Infinity",
      PROVIDER_GATEWAY_UPSTREAM_TIMEOUT_MS: "999999999",
    });
    expect(resolved).toEqual({
      maxRequestsPerRun: 256,
      maxConcurrentPerRun: 4,
      maxOutputTokens: 65_536,
      upstreamTimeoutMs: 600_000,
    });
  });
});
