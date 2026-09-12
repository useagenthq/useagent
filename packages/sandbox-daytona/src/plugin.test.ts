import { describe, expect, mock, test } from "bun:test";
import { SandboxCredentialError } from "@useagent/sandbox-contract";
import { daytonaApiConfig, daytonaPlugin } from "./plugin";

const fallback = { envName: "DAYTONA_SNAPSHOT", value: "useagent-runtime-v17" };

describe("Daytona plugin", () => {
  test("template reads the named env var and falls back to the shipped snapshot", () => {
    expect(daytonaPlugin.template({ DAYTONA_SNAPSHOT: " custom-v1 " }, fallback)).toBe("custom-v1");
    expect(daytonaPlugin.template({ DAYTONA_SNAPSHOT: "  " }, fallback)).toBe("useagent-runtime-v17");
    expect(daytonaPlugin.template({}, fallback)).toBe("useagent-runtime-v17");
  });

  test("configFromEnv defaults the API URL and target", () => {
    expect(daytonaApiConfig("key", {})).toEqual({
      apiKey: "key",
      apiUrl: "https://app.daytona.io/api",
      target: "us",
    });
    expect(daytonaPlugin.configFromEnv("key", { DAYTONA_API_URL: " https://daytona.example/api ", DAYTONA_TARGET: "eu" })).toEqual({
      apiKey: "key",
      apiUrl: "https://daytona.example/api",
      target: "eu",
    });
  });

  test("previewAuthHeaders carries the token in Daytona's header", () => {
    expect(daytonaPlugin.previewAuthHeaders("tok")).toEqual({ "x-daytona-preview-token": "tok" });
    expect(daytonaPlugin.previewAuthHeaders("")).toEqual({});
  });

  test("previewHostProblem accepts public HTTPS hosts and refuses local or private ones", () => {
    const env = { NODE_ENV: "production" };
    expect(daytonaPlugin.previewHostProblem(new URL("https://3000-abc.proxy.daytona.work/"), env)).toBeNull();
    expect(daytonaPlugin.previewHostProblem(new URL("http://3000-abc.proxy.daytona.work/"), env)).toBe(
      "Daytona exec-server preview must use HTTPS",
    );
    expect(daytonaPlugin.previewHostProblem(new URL("http://3000-abc.proxy.daytona.work/"), { NODE_ENV: "test" })).toBeNull();
    for (const host of [
      "localhost",
      "app.localhost",
      "printer.local",
      "metadata.google.internal",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
    ]) {
      expect(daytonaPlugin.previewHostProblem(new URL(`https://${host}/`), env)).toBe(
        "Codex exec-server preview host is unavailable",
      );
    }
    expect(daytonaPlugin.previewHostProblem(new URL("https://8.8.8.8/"), env)).toBeNull();
  });

  test("validateCredential throws the shared credential error with the API status", async () => {
    const sdk = await import("@daytona/sdk");
    let failure: Error = new sdk.DaytonaAuthenticationError("bad key", 401);
    const configs: unknown[] = [];
    // Fake only the client class; the SDK error classes stay real so the mapping is the production one.
    mock.module("@daytona/sdk", () => ({
      ...sdk,
      Daytona: class {
        readonly snapshot = {
          get: async () => {
            throw failure;
          },
        };
        constructor(config: unknown) {
          configs.push(config);
        }
      },
    }));

    const error = await daytonaPlugin.validateCredential!({ apiKey: "key", snapshotName: "snap" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxCredentialError);
    expect(error).toMatchObject({ code: "authentication_failed", httpStatus: 401 });
    expect(configs[0]).toMatchObject({ apiKey: "key", requestTimeoutMs: 15_000, useDeprecatedPolling: true });

    failure = new sdk.DaytonaRateLimitError("slow down", 429);
    await expect(daytonaPlugin.validateCredential!({ apiKey: "key", snapshotName: "snap" })).rejects.toMatchObject({
      code: "rate_limited",
      httpStatus: 429,
    });

    await expect(daytonaPlugin.validateCredential!({ apiKey: "key" })).rejects.toMatchObject({
      code: "snapshot_not_found",
      httpStatus: 404,
    });
  });

  test("an IPv6 loopback literal is refused like the IPv4 one", () => {
    expect(daytonaPlugin.previewHostProblem(new URL("https://[::1]:8080/"), {})).toBe("Codex exec-server preview host is unavailable");
    expect(daytonaPlugin.previewHostProblem(new URL("https://127.0.0.1:8080/"), {})).toBe("Codex exec-server preview host is unavailable");
  });
});
