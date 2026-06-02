import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  preparePiRuntime,
  PI_CODING_AGENT_UPSTREAM_SHA,
  PI_CODING_AGENT_VERSION,
} from "./pi-runtime-config";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("Pi runtime configuration", () => {
  test("pins the npm release corresponding to the reviewed upstream revision", () => {
    expect(PI_CODING_AGENT_VERSION).toBe("18.0.3");
    expect(PI_CODING_AGENT_UPSTREAM_SHA).toBe("160ed439ac0df594347e7d7018b813a7ffdb5e81");
  });

  test("writes signed model and MCP config without putting either token in prompt text", async () => {
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
    expect(uploads.map((entry) => entry.path)).toEqual([
      "/root/.useagent/pi-home/agent/models.json",
      "/root/work/.mcp.json",
    ]);
    expect(uploads[1]!.text).toContain("skynet-knowledge");
    expect(commands.join("\n")).toContain(`@oh-my-pi/pi-coding-agent@${PI_CODING_AGENT_VERSION}`);
    expect(commands.join("\n")).not.toContain("clean user prompt");
  });
});
