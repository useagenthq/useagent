import { describe, expect, test } from "bun:test";
import {
  assertGatewayCapabilitySecret,
  assertGatewayRuntimeConfiguration,
  validateGatewayPublicUrl,
} from "./gateway-boundary";

const secureEnv = {
  USEAGENT_DEV_MODE: "false",
  PROVIDER_GATEWAY_SECRET: "provider-0123456789abcdef0123456789abcdef",
  TOOL_GATEWAY_SECRET: "tool-0123456789abcdef0123456789abcdef0123",
  SECRETS_ENCRYPTION_KEY: "encryption-0123456789abcdef0123456789abcdef",
  GATEWAY_DATABASE_URL: "postgres://gateway@example/db",
};

describe("gateway trust-boundary configuration", () => {
  test("requires HTTPS except for explicit local-development loopback", () => {
    expect(validateGatewayPublicUrl("https://gateway.example.test/", secureEnv)).toBe(
      "https://gateway.example.test",
    );
    expect(
      validateGatewayPublicUrl("http://127.0.0.1:3202", { USEAGENT_DEV_MODE: "true" }),
    ).toBe("http://127.0.0.1:3202");
    expect(() =>
      validateGatewayPublicUrl("http://gateway.example.test", { USEAGENT_DEV_MODE: "true" }),
    ).toThrow("requires HTTPS");
    expect(() => validateGatewayPublicUrl("https://u:p@gateway.example.test")).toThrow(
      "credential-free origin",
    );
    expect(() => validateGatewayPublicUrl("https://gateway.example.test/path")).toThrow(
      "must not include a path",
    );
  });

  test("external capabilities require a dedicated strong secret", () => {
    expect(() =>
      assertGatewayCapabilitySecret("PROVIDER_GATEWAY_SECRET", {}),
    ).toThrow("at least 32");
    expect(() =>
      assertGatewayCapabilitySecret("PROVIDER_GATEWAY_SECRET", {
        PROVIDER_GATEWAY_SECRET: "same-secret-with-more-than-thirty-two-characters",
        BETTER_AUTH_SECRET: "same-secret-with-more-than-thirty-two-characters",
      }),
    ).toThrow("independent");
  });

  test("production gateway requires independent roots and a restricted DB URL", () => {
    expect(() => assertGatewayRuntimeConfiguration(secureEnv)).not.toThrow();
    expect(() =>
      assertGatewayRuntimeConfiguration({ ...secureEnv, GATEWAY_DATABASE_URL: undefined }),
    ).toThrow("GATEWAY_DATABASE_URL");
    expect(() =>
      assertGatewayRuntimeConfiguration({
        ...secureEnv,
        TOOL_GATEWAY_SECRET: secureEnv.PROVIDER_GATEWAY_SECRET,
      }),
    ).toThrow("must be independent");
  });

  test("gateway app imports in production without the full backend auth root", async () => {
    const entry = new URL("../gateway-app.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(entry)})`], {
      env: {
        ...process.env,
        ...secureEnv,
        BETTER_AUTH_SECRET: "",
        DATABASE_URL: "postgres://postgres@localhost:5432/useagent",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(0);
  });
});
