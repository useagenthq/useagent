import { describe, expect, test } from "bun:test";
import { cubePlugin } from "./plugin";

describe("Cube plugin", () => {
  test("template requires CUBE_TEMPLATE_ID and ignores the Daytona fallback", () => {
    expect(cubePlugin.template({ CUBE_TEMPLATE_ID: " tpl-1 " }, "DAYTONA_SNAPSHOT")).toBe("tpl-1");
    expect(() => cubePlugin.template({ DAYTONA_SNAPSHOT: "snap" }, "DAYTONA_SNAPSHOT")).toThrow(
      "CUBE_TEMPLATE_ID is required when SANDBOX_PROVIDER=cube",
    );
  });

  test("configFromEnv carries only the key", () => {
    expect(cubePlugin.configFromEnv("key", { CUBE_API_URL: "http://127.0.0.1:3000" })).toEqual({ apiKey: "key" });
  });

  test("uses the pinned Bun path baked into Cube root images", () => {
    expect(cubePlugin.runtime.bunExecutable).toBe("/usr/local/bin/bun");
  });

  test("previewAuthHeaders carries the traffic token in both Cube and E2B headers", () => {
    expect(cubePlugin.previewAuthHeaders("tok")).toEqual({
      "cube-traffic-access-token": "tok",
      "e2b-traffic-access-token": "tok",
    });
    expect(cubePlugin.previewAuthHeaders("")).toEqual({});
  });

  test("createProvider needs the control plane's identity preflight command", () => {
    expect(() => cubePlugin.createProvider({ apiKey: "" })).toThrow("Cube provider needs identityPreflightCommand");
    expect(cubePlugin.createProvider({ apiKey: "" }, { identityPreflightCommand: "true" })).toHaveProperty("create");
  });

  test("previewHostProblem accepts the sandbox domain and its subdomains only", () => {
    expect(cubePlugin.previewHostProblem(new URL("https://3000-cube-1.cube.app/"), {})).toBeNull();
    expect(cubePlugin.previewHostProblem(new URL("http://cube.app/"), {})).toBeNull();
    expect(cubePlugin.previewHostProblem(new URL("https://3000-cube-1.sandbox.example.com/"), {
      CUBE_SANDBOX_DOMAIN: " Sandbox.Example.com ",
    })).toBeNull();
    for (const url of ["https://notcube.app/", "https://cube.app.evil.example/", "https://3000-cube-1.cube.app.evil.example/"]) {
      expect(cubePlugin.previewHostProblem(new URL(url), {})).toBe(
        "Codex exec-server preview is outside the Cube sandbox domain",
      );
    }
    expect(cubePlugin.previewHostProblem(new URL("https://3000-cube-1.cube.app/"), { CUBE_SANDBOX_DOMAIN: "sandbox.example.com" })).toBe(
      "Codex exec-server preview is outside the Cube sandbox domain",
    );
  });
});
