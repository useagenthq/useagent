import { describe, expect, test } from "bun:test";
import { selfSignupEnabled } from "../src/env";

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
