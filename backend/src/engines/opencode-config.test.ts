import { afterEach, describe, expect, test } from "bun:test";
import type { EngineRunContext } from "./types";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  buildOpencodeConfigWriteCommand,
  prepareOpencodeSandboxConfig,
} from "./opencode-sandbox-config";
import { verifyToolToken } from "../knowledge/gateway/token";
import { LEGACY_TOOL_GATEWAY_SERVER_NAME, TOOL_GATEWAY_SERVER_NAME } from "../knowledge/gateway/descriptor";

const original = { ...process.env };

afterEach(() => {
  for (const name of [
    "GATEWAY_PUBLIC_URL",
    "PROVIDER_GATEWAY_SECRET",
    "TOOL_GATEWAY_SECRET",
    "TOOL_GATEWAY_TOKEN_TTL_MS",
  ]) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function runContext(): EngineRunContext {
  return {
    runId: "run-opencode-config",
    prompt: "x",
    bootstrapContext: "",
    turnContext: "",
    workdir: "/work",
    threadId: "thread-opencode-config",
    orgId: "org-a",
    userId: "user-a",
    model: "claude-opus-5",
    signal: new AbortController().signal,
    emit: async () => undefined,
    setSummary: () => {},
  };
}

describe("OpenCode generated config placement", () => {
  test("writes capabilities to the global config and removes the project copy", () => {
    const command = buildOpencodeConfigWriteCommand("e30=");

    expect(command).toContain("> ~/.config/opencode/opencode.json");
    expect(command).toContain("chmod 600 ~/.config/opencode/opencode.json");
    expect(command).toContain("rm -f -- ~/work/opencode.json");
    expect(command).not.toContain("tee");
  });

  test("rejects shell input that is not base64", () => {
    expect(() => buildOpencodeConfigWriteCommand("$(touch /tmp/nope)")).toThrow(
      "opencode config must be base64 encoded",
    );
  });

  test("keeps the memoized knowledge token within the configured TTL", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_TOKEN_TTL_MS = "60000";
    const before = Date.now();

    const prepared = await prepareOpencodeSandboxConfig(
      {} as SandboxHandle,
      runContext(),
      {},
    );
    const after = Date.now();
    const mcp = prepared?.config.mcp as Record<
      string,
      { headers: { Authorization: string } }
    >;
    const token = mcp[TOOL_GATEWAY_SERVER_NAME]!.headers.Authorization.replace(/^Bearer /, "");
    expect(mcp[LEGACY_TOOL_GATEWAY_SERVER_NAME]).toBeUndefined();
    const claims = verifyToolToken(token, before);

    expect(prepared?.config.provider).toMatchObject({
      cerebras: {
        npm: "@ai-sdk/cerebras",
        name: "Cerebras",
        options: { baseURL: "https://gateway.example.test/api/provider/cerebras/v1" },
        models: {
          "qwen-3.8-27b": {
            name: "Qwen 3.8 27B",
            limit: { context: 65_536, output: 16_384 },
          },
          "gemma-4-31b": {
            name: "Gemma 4 31B",
            limit: { context: 131_072, output: 40_960 },
          },
        },
      },
    });

    expect(claims).not.toBeNull();
    expect(claims!.exp).toBeGreaterThanOrEqual(before + 60_000);
    expect(claims!.exp).toBeLessThanOrEqual(after + 60_000);
  });

  test("keeps observed Qwen sessions below OpenCode's effective input budget", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const prepared = await prepareOpencodeSandboxConfig(
      {} as SandboxHandle,
      runContext(),
      {
        provider: {
          cerebras: {
            models: {
              "qwen-3.8-27b": {
                name: "stale Qwen definition",
                limit: { context: 65_536, output: 32_768 },
              },
            },
          },
        },
      },
    );
    const cerebras = (prepared?.config.provider as Record<string, unknown>)
      .cerebras as { models: Record<string, { limit: { context: number; output: number } }> };
    const qwen = cerebras.models["qwen-3.8-27b"]!;
    const inputHeadroom = qwen.limit.context - qwen.limit.output;

    expect(qwen.limit).toEqual({ context: 65_536, output: 16_384 });
    expect(inputHeadroom).toBe(49_152);
    expect(42_320).toBeLessThan(inputHeadroom);
    expect(37_691).toBeLessThan(inputHeadroom);
  });
});
