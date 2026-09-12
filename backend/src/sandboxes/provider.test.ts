import { afterEach, describe, expect, test } from "bun:test";
import { DaytonaProvider } from "./daytona-provider";
import {
  boxApiConfig,
  sandboxPreviewHeaders,
  sandboxProvider,
  sandboxProviderApiKey,
  sandboxProviderKind,
  sandboxTemplate,
} from "./provider";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("sandbox provider selection", () => {
  test("keeps Daytona as the default", () => {
    expect(sandboxProviderKind({})).toBe("daytona");
  });

  test("constructs the explicit Daytona adapter", () => {
    delete process.env.SANDBOX_PROVIDER;
    expect(sandboxProvider("daytona-key")).toBeInstanceOf(DaytonaProvider);
  });

  test("selects Cube explicitly", () => {
    expect(sandboxProviderKind({ SANDBOX_PROVIDER: "cube" })).toBe("cube");
  });

  test("rejects unknown providers instead of silently falling back", () => {
    expect(() => sandboxProviderKind({ SANDBOX_PROVIDER: "other" })).toThrow(
      "SANDBOX_PROVIDER must be daytona, cube, or box",
    );
  });

  test("resolves the selected provider credential", () => {
    expect(sandboxProviderApiKey({ DAYTONA_API_KEY: "daytona-key" })).toBe("daytona-key");
    expect(
      sandboxProviderApiKey({
        SANDBOX_PROVIDER: "cube",
        CUBE_API_KEY: "cube-key",
        DAYTONA_API_KEY: "daytona-key",
      }),
    ).toBe("cube-key");
  });

  test("allows a loopback Cube deployment without API auth", () => {
    expect(
      sandboxProviderApiKey({
        SANDBOX_PROVIDER: "cube",
        CUBE_API_URL: "http://127.0.0.1:3000",
      }),
    ).toBe("");
  });

  test("uses the Cube template instead of a Daytona snapshot", () => {
    expect(
      sandboxTemplate("DAYTONA_SNAPSHOT", "daytona-default", {
        SANDBOX_PROVIDER: "cube",
        CUBE_TEMPLATE_ID: "cube-template",
        DAYTONA_SNAPSHOT: "daytona-template",
      }),
    ).toBe("cube-template");
    expect(
      sandboxTemplate("DAYTONA_SNAPSHOT", "daytona-default", {
        DAYTONA_SNAPSHOT: "daytona-template",
      }),
    ).toBe("daytona-template");
  });
});

describe("Box provider selection", () => {
  test("selects Box explicitly and reads its own key, snapshot, and machine type", () => {
    const env = { SANDBOX_PROVIDER: "box", BOX_API_KEY: " box_key ", BOX_SNAPSHOT: "useagent-runtime", BOX_MACHINE_TYPE: "large" };
    expect(sandboxProviderKind(env)).toBe("box");
    expect(sandboxProviderApiKey(env)).toBe("box_key");
    expect(sandboxTemplate("DAYTONA_SNAPSHOT", "fallback", env)).toBe("useagent-runtime");
    expect(sandboxTemplate("DAYTONA_SNAPSHOT", "fallback", { SANDBOX_PROVIDER: "box" })).toBe("");
    expect(boxApiConfig("k", env)).toEqual({ apiKey: "k", apiUrl: "https://ascii.dev/api/box/v1", machineType: "large" });
    expect(() => boxApiConfig("k", { BOX_MACHINE_TYPE: "huge" })).toThrow(/BOX_MACHINE_TYPE/);
  });

  test("Box preview auth is the port-auth cookie, never a token header", () => {
    expect(sandboxPreviewHeaders("tok", "box")).toEqual({ cookie: "_port_auth=tok" });
  });
});

describe("sandbox preview authentication", () => {
  test("emits only Daytona preview authentication for Daytona", () => {
    expect(sandboxPreviewHeaders("preview-token", "daytona")).toEqual({
      "x-daytona-preview-token": "preview-token",
    });
  });

  test("supports Cube's E2B-compatible traffic token names", () => {
    expect(sandboxPreviewHeaders("preview-token", "cube")).toEqual({
      "cube-traffic-access-token": "preview-token",
      "e2b-traffic-access-token": "preview-token",
    });
  });

  test("does not emit empty credential headers", () => {
    expect(sandboxPreviewHeaders("")).toEqual({});
  });
});
