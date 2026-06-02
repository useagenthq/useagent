import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  preparePiRuntime,
  piApiForProvider,
  piModelSelection,
  PI_BUN_VERSION,
  PI_CODING_AGENT_UPSTREAM_SHA,
  PI_CODING_AGENT_VERSION,
  PI_RUNTIME_LOCK_SHA256,
} from "./pi-runtime-config";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("Pi runtime configuration", () => {
  test("pins the npm release corresponding to the reviewed upstream revision", async () => {
    expect(PI_CODING_AGENT_VERSION).toBe("18.0.3");
    expect(PI_BUN_VERSION).toBe("1.3.14");
    expect(PI_CODING_AGENT_UPSTREAM_SHA).toBe("160ed439ac0df594347e7d7018b813a7ffdb5e81");
    expect(PI_RUNTIME_LOCK_SHA256).toHaveLength(64);
    const lock = await readFile(new URL("../../pi-runtime/package-lock.json", import.meta.url));
    const manifest = JSON.parse(await readFile(
      new URL("../../pi-runtime/package.json", import.meta.url),
      "utf8",
    )) as { dependencies: Record<string, string> };
    expect(manifest.dependencies.bun).toBe(PI_BUN_VERSION);
    expect(createHash("sha256").update(lock).digest("hex")).toBe(PI_RUNTIME_LOCK_SHA256);
    expect(piApiForProvider("openrouter")).toBe("openai-completions");
    expect(piModelSelection("google/gemini-3.7-flash")).toEqual({
      provider: "openrouter",
      modelId: "google/gemini-3.7-flash",
      selector: "openrouter/google/gemini-3.7-flash",
    });
  });

  test("keeps signed credentials behind the root broker and installs from the immutable lock", async () => {
    process.env.PROVIDER_GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-secret-provider-secret-1234";
    process.env.GATEWAY_PUBLIC_URL = "https://tools.example.test";
    process.env.TOOL_GATEWAY_SECRET = "tools-secret-tools-secret-12345678";
    const uploads: Array<{ path: string; text: string }> = [];
    const commands: string[] = [];
    const sandbox = {
      id: "box",
      fs: {
        uploadFile: mock(async (bytes: Buffer, path: string) => {
          uploads.push({ path, text: bytes.toString("utf8") });
        }),
      },
      process: {
        executeCommand: mock(async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: "" };
        }),
      },
    } as never;
    const runtime = await preparePiRuntime(
      sandbox,
      {
        runId: "run",
        threadId: "thread",
        orgId: "org",
        userId: "user",
        model: "openai/gpt-5.6-sol",
        prompt: "clean user prompt",
      } as never,
      "/root/work",
    );

    expect(runtime.model).toEqual({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      selector: "openai/gpt-5.6-sol",
    });
    const models = uploads.find((entry) => entry.path.endsWith("/models.json"));
    const mcp = uploads.find((entry) => entry.path.endsWith("/.mcp.json"));
    const brokerConfig = uploads.find((entry) => entry.path === "/root/.useagent/pi-broker/capabilities.json");
    expect(models?.path).toBe("/home/useagent-pi/agent/models.json");
    expect(models?.text).toContain("useagent-broker");
    expect(models?.text).not.toContain("Bearer ");
    expect(mcp?.text).toContain("http://127.0.0.1:19483/mcp");
    expect(mcp?.text).not.toContain("Authorization");
    expect(brokerConfig?.text).toContain("Bearer ");
    expect(commands.join("\n")).toContain("npm ci --omit=dev --silent");
    expect(commands.join("\n")).toContain(PI_RUNTIME_LOCK_SHA256);
    expect(commands.join("\n")).not.toContain("command -v bun");
    expect(commands.join("\n")).not.toContain("clean user prompt");
    expect(runtime).toMatchObject({
      executable: "/opt/useagent/pi-runtime/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
      bunExecutable: "/opt/useagent/pi-runtime/current/node_modules/.bin/bun",
      runAsUser: "useagent-pi",
      home: "/home/useagent-pi",
    });
  });
});
