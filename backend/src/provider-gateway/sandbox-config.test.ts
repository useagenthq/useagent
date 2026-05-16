import { afterEach, describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import type { EngineRunContext } from "../engines/types";
import {
  opencodeProviderGatewayOptions,
  providerGatewayEnv,
  providerGatewaySandboxLabels,
  providerGatewaySandboxIsCurrent,
  providerGatewayWired,
  prepareProviderGatewaySandbox,
  codexProviderConfigToml,
  SANDBOX_GENERATION,
} from "./sandbox-config";
import { verifyProviderToken } from "./token";
import { verifyToolToken } from "../knowledge/gateway/token";

const original = { ...process.env };

afterEach(() => {
  for (const name of [
    "PROVIDER_GATEWAY_PUBLIC_URL",
    "GATEWAY_PUBLIC_URL",
    "TOOL_GATEWAY_PUBLIC_URL",
    "PROVIDER_GATEWAY_TOKEN_TTL_MS",
    "PROVIDER_GATEWAY_SECRET",
    "TOOL_GATEWAY_SECRET",
  ]) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function ctx(): EngineRunContext {
  return {
    runId: "run-a",
    prompt: "x",
    bootstrapContext: "",
    turnContext: "",
    workdir: "/work",
    threadId: "thread-a",
    orgId: "org-a",
    userId: "user-a",
    model: "claude-opus-5",
    signal: new AbortController().signal,
    emit: async () => undefined,
    setSummary: () => {},
  };
}

function recordingSandbox(): {
  readonly sandbox: SandboxHandle;
  readonly files: Record<string, string>;
} {
  const files: Record<string, string> = {};
  const sandbox = {
    process: {
      executeCommand: async (command: string) => {
        for (const match of command.matchAll(/printf %s '([^']+)' \| base64 -d > ([^ ]+)/g)) {
          files[match[2]!] = Buffer.from(match[1]!, "base64").toString("utf8");
        }
        return { exitCode: 0, result: "" };
      },
    },
  } as unknown as SandboxHandle;
  return { sandbox, files };
}

describe("sandbox provider gateway config", () => {
  test("is inert when no sandbox-reachable gateway exists", () => {
    delete process.env.PROVIDER_GATEWAY_PUBLIC_URL;
    delete process.env.GATEWAY_PUBLIC_URL;
    delete process.env.TOOL_GATEWAY_PUBLIC_URL;
    expect(providerGatewayWired()).toBe(false);
    expect(providerGatewayEnv(ctx(), "claude")).toEqual({});
  });

  test("does not accept the legacy full-backend tunnel variable", () => {
    delete process.env.PROVIDER_GATEWAY_PUBLIC_URL;
    delete process.env.GATEWAY_PUBLIC_URL;
    process.env.TOOL_GATEWAY_PUBLIC_URL = "https://full-backend.example.test";
    expect(providerGatewayWired()).toBe(false);
  });

  test("Claude uses a dynamic key helper and Codex uses command-backed auth", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test/";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const claude = providerGatewayEnv(ctx(), "claude");
    expect(claude.ANTHROPIC_BASE_URL).toBe("https://gateway.example.test/api/provider/anthropic");
    expect(claude.CLAUDE_CONFIG_DIR).toBe("/tmp/skynet-claude-config");
    expect(claude).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(claude).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(claude.ANTHROPIC_MODEL).toBe("claude-opus-5[1m]");
    expect(claude.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-opus-5[1m]");
    expect(claude.CLAUDE_CODE_API_KEY_HELPER_TTL_MS).toBe("1");

    const codex = providerGatewayEnv(ctx(), "codex");
    expect(codex).toEqual({});
    const config = codexProviderConfigToml(
      "gpt-5.6-sol",
      { url: "https://gateway.example.test/api/mcp/knowledge", bearerToken: "tool-token" },
    );
    expect(config).toContain('model = "gpt-5.6-sol"');
    expect(config).toContain('model_provider = "skynet"');
    expect(config).toContain('sandbox_mode = "danger-full-access"');
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain(
      'base_url = "https://gateway.example.test/api/provider/openai/v1"',
    );
    expect(config).toContain("[model_providers.skynet.auth]");
    expect(config).toContain('command = "sh"');
    expect(config).not.toContain("env_key");
    expect(config).toContain("[mcp_servers.skynet-knowledge]");
    expect(config).toContain('url = "https://gateway.example.test/api/mcp/knowledge"');
    expect(config).toContain('http_headers = { Authorization = "Bearer tool-token" }');
    expect(config).toContain("enabled = true");
    expect(config).toContain("required = true");
  });

  test("leaves 200K model ids unchanged", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const context = ctx();
    context.model = "claude-haiku-4-5";

    expect(providerGatewayEnv(context, "claude").ANTHROPIC_MODEL).toBe(
      "claude-haiku-4-5",
    );
  });

  test("OpenCode pre-wires both providers for warm model switches", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const options = opencodeProviderGatewayOptions(ctx());
    expect(options.anthropic?.baseURL).toEndWith("/api/provider/anthropic/v1");
    expect(options.openrouter?.baseURL).toEndWith("/api/provider/openrouter/v1");
    expect(verifyProviderToken(options.anthropic?.apiKey)).toMatchObject({ provider: "anthropic" });
    expect(verifyProviderToken(options.openrouter?.apiKey)).toMatchObject({ provider: "openrouter" });
    expect(SANDBOX_GENERATION).toBe("provider-gateway-v12-native-computer-use");
    expect(providerGatewaySandboxLabels("run-a")).toEqual({
      "skynet-run": "run-a",
      "skynet-provider-generation": SANDBOX_GENERATION,
    });
  });

  test("OpenCode thread provider tokens are memoized per user", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const first = ctx();
    first.threadId = "thread-provider-user-key";
    first.runId = "run-provider-a";
    first.userId = "user-a";
    const second = ctx();
    second.threadId = "thread-provider-user-key";
    second.runId = "run-provider-b";
    second.userId = "user-b";

    const firstToken = opencodeProviderGatewayOptions(first).openrouter?.apiKey;
    const secondToken = opencodeProviderGatewayOptions(second).openrouter?.apiKey;

    expect(firstToken).not.toBe(secondToken);
    expect(verifyProviderToken(firstToken)).toMatchObject({
      userId: "user-a",
      issuedRunId: "run-provider-a",
      scope: "thread",
    });
    expect(verifyProviderToken(secondToken)).toMatchObject({
      userId: "user-b",
      issuedRunId: "run-provider-b",
      scope: "thread",
    });
  });

  test("Codex MCP tool tokens written to config are memoized per user", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    const first = ctx();
    first.threadId = "thread-tool-user-key";
    first.runId = "run-tool-a";
    first.userId = "user-a";
    first.model = "gpt-5.6-sol";
    const second = ctx();
    second.threadId = "thread-tool-user-key";
    second.runId = "run-tool-b";
    second.userId = "user-b";
    second.model = "gpt-5.6-sol";
    const { sandbox, files } = recordingSandbox();

    await prepareProviderGatewaySandbox(sandbox, first, "codex");
    const firstConfig = files["$HOME/.codex/config.toml"]!;
    await prepareProviderGatewaySandbox(sandbox, second, "codex");
    const secondConfig = files["$HOME/.codex/config.toml"]!;

    const firstBearer = firstConfig.match(/Authorization = "Bearer ([^"]+)"/)?.[1];
    const secondBearer = secondConfig.match(/Authorization = "Bearer ([^"]+)"/)?.[1];
    expect(firstBearer).toBeTruthy();
    expect(secondBearer).toBeTruthy();
    expect(firstBearer).not.toBe(secondBearer);
    expect(verifyToolToken(firstBearer)).toMatchObject({
      userId: "user-a",
      runId: "run-tool-a",
      scope: "thread",
    });
    expect(verifyToolToken(secondBearer)).toMatchObject({
      userId: "user-b",
      runId: "run-tool-b",
      scope: "thread",
    });
  });

  test("warm reuse trusts the Daytona generation label, not the sandbox file alone", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    let shellChecks = 0;
    const sandbox = {
      labels: {
        "skynet-run": "run-a",
        "skynet-provider-generation": "provider-gateway-v10",
      },
      process: {
        executeCommand: async () => {
          shellChecks++;
          return { exitCode: 0 };
        },
      },
    } as unknown as SandboxHandle;
    expect(await providerGatewaySandboxIsCurrent(sandbox)).toBe(false);
    expect(shellChecks).toBe(0);

    (sandbox as unknown as { labels: Record<string, string> }).labels =
      providerGatewaySandboxLabels("run-a");
    expect(await providerGatewaySandboxIsCurrent(sandbox)).toBe(true);
    expect(shellChecks).toBe(1);
  });
});
