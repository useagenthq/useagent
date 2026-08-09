import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildOpencodeConfigWriteCommand } from "./opencode-server";

describe("OpenCode generated config placement", () => {
  test("writes capabilities to the global config and removes the project copy", () => {
    const command = buildOpencodeConfigWriteCommand("e30=");

    expect(command).toContain("> ~/.config/opencode/opencode.json");
    expect(command).toContain("rm -f -- ~/work/opencode.json");
    expect(command).not.toContain("tee");
  });

  test("rejects shell input that is not base64", () => {
    expect(() => buildOpencodeConfigWriteCommand("$(touch /tmp/nope)")).toThrow(
      "opencode config must be base64 encoded",
    );
  });

  test("reloads every installed optional capability on a warm resident server", () => {
    const source = readFileSync(new URL("./opencode-server.ts", import.meta.url), "utf8");

    expect(source).toContain(
      "gatewayState.provider || gatewayState.knowledge || gatewayState.browser",
    );
  });
});
