import { describe, expect, mock, test } from "bun:test";
import { SandboxCredentialError } from "@useagent/sandbox-contract";
import { DAYTONA_SNAPSHOT_DEFAULTS, daytonaApiConfig, daytonaPlugin } from "./plugin";

describe("Daytona plugin", () => {
  test("template reads the lane's env var and falls back to the plugin's own pin", () => {
    expect(daytonaPlugin.template({ DAYTONA_SNAPSHOT: " custom-v1 " })).toBe("custom-v1");
    expect(daytonaPlugin.template({ DAYTONA_SNAPSHOT: "  " })).toBe(DAYTONA_SNAPSHOT_DEFAULTS.DAYTONA_SNAPSHOT ?? "");
    expect(daytonaPlugin.template({})).toBe("skynet-agent-v17");
    expect(daytonaPlugin.template({ DAYTONA_OTHER_SNAPSHOT: "other-custom" }, "DAYTONA_OTHER_SNAPSHOT")).toBe("other-custom");
    expect(() => daytonaPlugin.template({}, "DAYTONA_OTHER_SNAPSHOT")).toThrow(/no default snapshot for DAYTONA_OTHER_SNAPSHOT/);
    // The default image is far below the product target, so a fallback there is refused unless the target says so.
    expect(daytonaPlugin.baseImageResources).toEqual({ cpu: 1, memory: 1 });
  });

  test("configFromEnv defaults the API URL and target", () => {
    expect(daytonaApiConfig("key", {})).toEqual({
      apiKey: "key",
      apiUrl: "https://app.daytona.io/api",
      target: "us",
      requestTimeoutMs: 15_000,
    });
    expect(daytonaPlugin.configFromEnv("key", { DAYTONA_API_URL: " https://daytona.example/api ", DAYTONA_TARGET: "eu" })).toEqual({
      apiKey: "key",
      apiUrl: "https://daytona.example/api",
      target: "eu",
      requestTimeoutMs: 15_000,
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

  test("loopback, unspecified and IPv4-mapped literals are refused; DNS names that merely start with fd are not", () => {
    const refused = "Codex exec-server preview host is unavailable";
    for (const host of ["[::1]", "127.0.0.1", "[::]", "[::ffff:127.0.0.1]", "[::ffff:10.0.0.5]", "0.0.0.0", "[fd12::1]", "[fe80::1]"]) {
      expect(daytonaPlugin.previewHostProblem(new URL(`https://${host}:8080/`), {})).toBe(refused);
    }
    expect(daytonaPlugin.previewHostProblem(new URL("https://fd12.example.daytona.work/"), {})).toBeNull();
    expect(daytonaPlugin.previewHostProblem(new URL("https://[::ffff:8.8.8.8]:8080/"), {})).toBeNull();
  });
});
