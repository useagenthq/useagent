import { afterEach, describe, expect, test } from "bun:test";
import { mintProviderToken, verifyProviderToken } from "./token";

const previousSecret = process.env.PROVIDER_GATEWAY_SECRET;

afterEach(() => {
  if (previousSecret === undefined) delete process.env.PROVIDER_GATEWAY_SECRET;
  else process.env.PROVIDER_GATEWAY_SECRET = previousSecret;
});

describe("provider gateway capability", () => {
  const claims = {
    orgId: "org-a",
    userId: "user-a",
    threadId: "thread-a",
    issuedRunId: "run-a",
    engine: "opencode" as const,
    provider: "openrouter" as const,
  };

  test("round-trips every authorization dimension", () => {
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-secret";
    const token = mintProviderToken(claims, 60_000);
    expect(verifyProviderToken(token)).toMatchObject(claims);
  });

  test("rejects expiry, tampering, and a different provider secret", () => {
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-secret";
    const token = mintProviderToken(claims, 10);
    expect(verifyProviderToken(token, Date.now() + 11)).toBeNull();
    expect(verifyProviderToken(`${token.slice(0, -1)}x`)).toBeNull();
    process.env.PROVIDER_GATEWAY_SECRET = "different-secret";
    expect(verifyProviderToken(token)).toBeNull();
  });
});
