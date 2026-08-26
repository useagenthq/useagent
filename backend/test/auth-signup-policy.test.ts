import { describe, expect, test } from "bun:test";
import { betterAuthTrustedOrigins, selfSignupEnabled } from "../src/env";

describe("self-service signup policy", () => {
  test("is disabled in production even when no signup-specific flag exists", () => {
    expect(selfSignupEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(selfSignupEnabled({ NODE_ENV: "production", USEAGENT_DEV_MODE: "true" })).toBe(false);
    expect(selfSignupEnabled({ NODE_ENV: "production", USEAGENT_DEV_MODE: "false" })).toBe(false);
  });

  test("remains available in verified development mode for local tests", () => {
    expect(selfSignupEnabled({ NODE_ENV: "development", USEAGENT_DEV_MODE: "true" })).toBe(true);
    expect(selfSignupEnabled({ NODE_ENV: "development", USEAGENT_DEV_MODE: "false" })).toBe(false);
    expect(selfSignupEnabled({ NODE_ENV: "development" })).toBe(true);
  });
});

describe("Better Auth trusted origins", () => {
  test("keeps both legacy and app hosts during the domain transition", () => {
    expect(
      betterAuthTrustedOrigins({
        FRONTEND_ORIGIN: "https://app.useagent.org",
        BETTER_AUTH_URL: "https://app.useagent.org",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://skynet.meow.gs, https://app.useagent.org/",
      }),
    ).toEqual(["https://app.useagent.org", "https://skynet.meow.gs"]);
  });

  test("rejects non-HTTP origins", () => {
    expect(() =>
      betterAuthTrustedOrigins({
        FRONTEND_ORIGIN: "https://app.useagent.org",
        BETTER_AUTH_URL: "https://app.useagent.org",
        BETTER_AUTH_TRUSTED_ORIGINS: "javascript:alert(1)",
      }),
    ).toThrow("accepts only HTTP(S) origins");
  });
});
