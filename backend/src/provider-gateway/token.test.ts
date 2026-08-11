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
    // Corrupt a MIDDLE character - the final base64url char can carry padding
    // bits, so a last-char flip may decode to identical signature bytes (flaky).
    const m = Math.floor(token.length / 2);
    const differentChar = token[m] === "A" ? "B" : "A";
    expect(verifyProviderToken(`${token.slice(0, m)}${differentChar}${token.slice(m + 1)}`)).toBeNull();
    process.env.PROVIDER_GATEWAY_SECRET = "different-secret";
    expect(verifyProviderToken(token)).toBeNull();
  });
});

describe("thread-scoped capability wire format", () => {
  const base = {
    orgId: "org-a",
    userId: "user-a",
    threadId: "thread-a",
    issuedRunId: "run-a",
    engine: "opencode" as const,
    provider: "openrouter" as const,
  };

  test("legacy tokens (no scope marker) verify as run scope", () => {
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-secret";
    const token = mintProviderToken(base, 60_000);
    expect(verifyProviderToken(token)?.scope).toBe("run");
  });

  test("thread scope round-trips and stays signed", () => {
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-secret";
    const token = mintProviderToken({ ...base, scope: "thread" }, 60_000);
    const verified = verifyProviderToken(token);
    expect(verified?.scope).toBe("thread");
    expect(verified).toMatchObject(base);
    // Corrupt a MIDDLE character: the final base64url char can carry padding
    // bits, so flipping it may decode to identical signature bytes (a known
    // flaky-tamper pattern in this repo).
    const mid = Math.floor(token.length / 2);
    const flipped = token[mid] === "A" ? "B" : "A";
    expect(verifyProviderToken(`${token.slice(0, mid)}${flipped}${token.slice(mid + 1)}`)).toBeNull();
  });
});
