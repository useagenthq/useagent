import { describe, expect, test } from "bun:test";
import { evaluateVisibleBrowserPage } from "./browser-mcp";
import type { SandboxHandle } from "../sandboxes/provider";

describe("evaluateVisibleBrowserPage", () => {
  test("returns the value produced by the sandbox-local CDP evaluator", async () => {
    let command = "";
    const sandbox = {
      process: {
        executeCommand: async (value: string) => {
          command = value;
          return { exitCode: 0, result: 'noise\n__SKYNET_CDP_RESULT__{"ready":true}' };
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      evaluateVisibleBrowserPage<{ ready: boolean }>(sandbox, "({ ready: true })"),
    ).resolves.toEqual({ ready: true });
    expect(command).toContain("node -e");
    expect(command).not.toContain("ready: true");
    const encoded = command.match(/Buffer\.from\('([^']+)'/)?.[1];
    expect(encoded).toBeTruthy();
    const script = Buffer.from(encoded!, "base64").toString("utf8");
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("(async () => {");
  });

  test("fails closed when the evaluator does not return its result marker", async () => {
    const sandbox = {
      process: {
        executeCommand: async () => ({ exitCode: 1, result: "CDP unavailable" }),
      },
    } as unknown as SandboxHandle;

    await expect(
      evaluateVisibleBrowserPage(sandbox, "location.href"),
    ).rejects.toThrow("CDP unavailable");
  });
});
