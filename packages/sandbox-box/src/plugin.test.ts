import { describe, expect, test } from "bun:test";
import { boxApiConfig, boxPlugin } from "./plugin";

describe("Box plugin", () => {
  test("declares its identity and runtime layout", () => {
    expect(boxPlugin.kind).toBe("box");
    expect(boxPlugin.credentialEnv).toBe("BOX_API_KEY");
    expect(boxPlugin.credentialRequired).toBe(true);
    expect(boxPlugin.home).toBe("/home/user");
    expect(boxPlugin.runsAsRoot).toBe(false);
  });

  test("config from env validates the machine class and defaults the API URL", () => {
    expect(boxApiConfig("k", {})).toEqual({ apiKey: "k", apiUrl: "https://ascii.dev/api/box/v1", machineType: "default" });
    expect(boxApiConfig("k", { BOX_MACHINE_TYPE: "Small", BOX_API_URL: "https://box.example/api/", BOX_ENVIRONMENT: "team" })).toEqual({
      apiKey: "k",
      apiUrl: "https://box.example/api",
      machineType: "small",
      environment: "team",
    });
    expect(() => boxApiConfig("k", { BOX_MACHINE_TYPE: "huge" })).toThrow(/BOX_MACHINE_TYPE must be one of/);
  });

  test("template is the optional snapshot; empty means the base image", () => {
    expect(boxPlugin.template({}, { envName: "DAYTONA_SNAPSHOT", value: "ignored" })).toBe("");
    expect(boxPlugin.template({ BOX_SNAPSHOT: " useagent-runtime " }, { envName: "DAYTONA_SNAPSHOT", value: "ignored" })).toBe("useagent-runtime");
  });

  test("preview auth is the port-auth cookie, never a token header", () => {
    expect(boxPlugin.previewAuthHeaders("cookie-value")).toEqual({ cookie: "_port_auth=cookie-value" });
    expect(boxPlugin.previewAuthHeaders("")).toEqual({});
  });

  test("preview hosts must be HTTPS on the hosting domain", () => {
    expect(boxPlugin.previewHostProblem(new URL("https://slug-4096.on.ascii.dev/"), {})).toBeNull();
    expect(boxPlugin.previewHostProblem(new URL("http://slug-4096.on.ascii.dev/"), {})).toMatch(/outside the Box hosting domain/);
    expect(boxPlugin.previewHostProblem(new URL("https://on.ascii.dev.evil.example/"), {})).toMatch(/outside the Box hosting domain/);
    expect(boxPlugin.previewHostProblem(new URL("https://slug-1.boxes.example/"), { BOX_HOSTING_DOMAIN: "boxes.example" })).toBeNull();
  });
});
