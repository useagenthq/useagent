import { afterEach, describe, expect, test } from "bun:test";
import { selfSignupEnabled } from "../src/env";

const previousNodeEnv = process.env.NODE_ENV;
const previousDevMode = process.env.SKYNET_DEV_MODE;

afterEach(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDevMode === undefined) delete process.env.SKYNET_DEV_MODE;
  else process.env.SKYNET_DEV_MODE = previousDevMode;
});

describe("self-service signup policy", () => {
  test("is disabled in production even when no signup-specific flag exists", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SKYNET_DEV_MODE;
    expect(selfSignupEnabled()).toBe(false);
  });

  test("remains available in verified development mode for local tests", () => {
    process.env.NODE_ENV = "development";
    process.env.SKYNET_DEV_MODE = "true";
    expect(selfSignupEnabled()).toBe(true);
  });
});
