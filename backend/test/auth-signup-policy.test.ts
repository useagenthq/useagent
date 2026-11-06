import { describe, expect, test } from "bun:test";
import { betterAuthTrustedOrigins, openSignupConfig, sameSecret, selfSignupEnabled, signupRefusal } from "../src/env";

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

const MAIL = { CONNECTOR_EMAIL_HOST: "smtp.example.test", CONNECTOR_EMAIL_FROM: "hello@example.test" };

describe("open sign-up policy", () => {
  test("the switch needs the mail transport, then opens sign-up even in production", () => {
    expect(openSignupConfig({ SIGNUP_OPEN: "1" })).toBeNull();
    expect(openSignupConfig({ ...MAIL })).toBeNull();
    expect(openSignupConfig({ SIGNUP_OPEN: "1", ...MAIL })).toEqual({ domains: [], inviteCode: "" });
    expect(selfSignupEnabled({ NODE_ENV: "production", SIGNUP_OPEN: "1", ...MAIL })).toBe(true);
    expect(selfSignupEnabled({ NODE_ENV: "production", SIGNUP_OPEN: "1" })).toBe(false);
    expect(selfSignupEnabled({ NODE_ENV: "production", SIGNUP_OPEN: "0", ...MAIL })).toBe(false);
  });

  test("domains are parsed loosely and matched exactly", () => {
    const source = { SIGNUP_OPEN: "true", ...MAIL, SIGNUP_ALLOWED_DOMAINS: " @Acme.com, example.test ,, " };
    expect(openSignupConfig(source)?.domains).toEqual(["acme.com", "example.test"]);
    expect(signupRefusal("Dana@ACME.com", undefined, source)).toBeNull();
    expect(signupRefusal("dana@acme.com.evil.test", undefined, source)).toBe(
      "Sign-up is limited to @acme.com, @example.test addresses",
    );
    expect(signupRefusal("dana@sub.acme.com", undefined, source)).not.toBeNull();
  });

  test("the invite code must match exactly, whatever the address", () => {
    const source = { SIGNUP_OPEN: "1", ...MAIL, SIGNUP_INVITE_CODE: " feedback-2026 " };
    expect(signupRefusal("a@b.test", "feedback-2026", source)).toBeNull();
    expect(signupRefusal("a@b.test", " feedback-2026 ", source)).toBeNull();
    expect(signupRefusal("a@b.test", "feedback-2027", source)).toBe("That invite code is not valid");
    expect(signupRefusal("a@b.test", "", source)).toBe("That invite code is not valid");
    expect(signupRefusal("a@b.test", undefined, source)).toBe("That invite code is not valid");
    expect(signupRefusal("a@b.test", ["feedback-2026"], source)).toBe("That invite code is not valid");
  });

  test("an invited address passes the domain rule and the code; the closed rule still stands", () => {
    const source = { SIGNUP_OPEN: "1", ...MAIL, SIGNUP_ALLOWED_DOMAINS: "acme.com", SIGNUP_INVITE_CODE: "feedback-2026" };
    expect(signupRefusal("guest@other.test", undefined, source, true)).toBeNull();
    expect(signupRefusal("guest@other.test", undefined, source, false)).toBe("Sign-up is limited to @acme.com addresses");
    expect(signupRefusal("guest@other.test", undefined, { NODE_ENV: "production" }, true)).toBe("Account creation is disabled");
  });

  test("secrets compare in constant time whatever their lengths", () => {
    expect(sameSecret("feedback-2026", "feedback-2026")).toBe(true);
    expect(sameSecret("feedback-202", "feedback-2026")).toBe(false);
    expect(sameSecret("", "feedback-2026")).toBe(false);
  });

  test("without the switch the closed rule stands", () => {
    expect(signupRefusal("a@b.test", undefined, { NODE_ENV: "production" })).toBe("Account creation is disabled");
    expect(signupRefusal("a@b.test", undefined, { NODE_ENV: "production", SIGNUP_OPEN: "1" })).toBe(
      "Account creation is disabled",
    );
    expect(signupRefusal("a@b.test", undefined, { NODE_ENV: "development" })).toBeNull();
  });
});

describe("Better Auth trusted origins", () => {
  test("keeps both legacy and app hosts during the domain transition", () => {
    expect(
      betterAuthTrustedOrigins({
        FRONTEND_ORIGIN: "https://app.useagent.org",
        BETTER_AUTH_URL: "https://app.useagent.org",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://legacy.example.com, https://app.useagent.org/",
      }),
    ).toEqual(["https://app.useagent.org", "useagent:/", "https://legacy.example.com"]);
  });

  test("rejects non-HTTP origins", () => {
    expect(() =>
      betterAuthTrustedOrigins({
        FRONTEND_ORIGIN: "https://app.useagent.org",
        BETTER_AUTH_URL: "https://app.useagent.org",
        BETTER_AUTH_TRUSTED_ORIGINS: "javascript:alert(1)",
      }),
    ).toThrow("accepts only HTTP(S) origins and the UseAgent desktop scheme");
  });
});
