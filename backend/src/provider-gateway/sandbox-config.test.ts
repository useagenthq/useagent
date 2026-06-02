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
    "TOOL_GATEWAY_TOKEN_TTL_MS",
    "PROVIDER_GATEWAY_SECRET",
    "TOOL_GATEWAY_SECRET",
    "NODE_ENV",
    "USEAGENT_DEV_MODE",
    "SANDBOX_SECRET_MODE",
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

function expectLifetime(
  exp: number,
  mintedBetween: readonly [number, number],
  ttlMs: number,
): void {
  expect(exp).toBeGreaterThanOrEqual(mintedBetween[0] + ttlMs);
  expect(exp).toBeLessThanOrEqual(mintedBetween[1] + ttlMs);
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

  test("Claude receives a private thread-scoped knowledge MCP capability", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    const { sandbox, files } = recordingSandbox();

    await prepareProviderGatewaySandbox(sandbox, ctx(), "claude");

    const mcpConfig = JSON.parse(
      files["/tmp/skynet-claude-config/skynet-mcp.json"]!,
    ) as {
      mcpServers: Record<
        string,
        { type: string; url: string; headers: { Authorization: string } }
      >;
    };
    const knowledge = mcpConfig.mcpServers["skynet-knowledge"]!;
    expect(knowledge).toMatchObject({
      type: "http",
      url: "https://gateway.example.test/api/mcp/knowledge",
    });
    const bearerToken = knowledge.headers.Authorization.replace(/^Bearer /, "");
    expect(verifyToolToken(bearerToken)).toMatchObject({
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-a",
      runId: "run-a",
      scope: "thread",
    });
    expect(files["/tmp/skynet-claude-config/settings.json"]).not.toContain(bearerToken);
    expect(files["/tmp/skynet-claude-config/settings.json"]).not.toContain(
      process.env.TOOL_GATEWAY_SECRET!,
    );
    expect(files["/tmp/skynet-claude-config/skynet-mcp.json"]).not.toContain(
      process.env.TOOL_GATEWAY_SECRET!,
    );
  });

  test("Claude warm replies reuse a user-bound thread provider capability", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    const first = ctx();
    first.threadId = "thread-claude-warm-provider";
    first.runId = "run-claude-warm-a";
    const second = ctx();
    second.threadId = first.threadId;
    second.runId = "run-claude-warm-b";
    const { sandbox, files } = recordingSandbox();

    await prepareProviderGatewaySandbox(sandbox, first, "claude");
    const firstToken = files["$HOME/.skynet/provider-anthropic.token"];
    await prepareProviderGatewaySandbox(sandbox, second, "claude");
    const secondToken = files["$HOME/.skynet/provider-anthropic.token"];

    expect(secondToken).toBe(firstToken);
    expect(verifyProviderToken(secondToken)).toMatchObject({
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-claude-warm-provider",
      issuedRunId: "run-claude-warm-a",
      engine: "claude",
      provider: "anthropic",
      scope: "thread",
    });
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

  test("OpenCode pre-wires all paid providers for warm model switches", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.SANDBOX_SECRET_MODE = "gateway_only";
    const options = opencodeProviderGatewayOptions(ctx());
    expect(options.anthropic?.baseURL).toEndWith("/api/provider/anthropic/v1");
    expect(options.openai?.baseURL).toEndWith("/api/provider/openai/v1");
    expect(options.openrouter?.baseURL).toEndWith("/api/provider/openrouter/v1");
    expect(verifyProviderToken(options.anthropic?.apiKey)).toMatchObject({ provider: "anthropic" });
    expect(verifyProviderToken(options.openai?.apiKey)).toMatchObject({ provider: "openai" });
    expect(verifyProviderToken(options.openrouter?.apiKey)).toMatchObject({ provider: "openrouter" });
    expect(SANDBOX_GENERATION).toBe("provider-gateway-v15-gateway-only-secrets");
    expect(providerGatewaySandboxLabels("run-a")).toEqual({
      "skynet-run": "run-a",
      "skynet-provider-generation": SANDBOX_GENERATION,
    });
  });

  test.each([
    ["default", undefined, 4 * 60 * 60 * 1000 + 15 * 60 * 1000],
    ["maximum", String(5 * 60 * 60 * 1000), 5 * 60 * 60 * 1000],
    ["custom", "60000", 60_000],
  ] as const)("configured %s provider TTL is the signed-token lifetime ceiling", (_name, rawTtl, ttlMs) => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    if (rawTtl === undefined) delete process.env.PROVIDER_GATEWAY_TOKEN_TTL_MS;
    else process.env.PROVIDER_GATEWAY_TOKEN_TTL_MS = rawTtl;
    const context = ctx();
    context.threadId = `thread-provider-lifetime-${_name}`;
    context.runId = `run-provider-lifetime-${_name}`;

    const before = Date.now();
    const token = opencodeProviderGatewayOptions(context).anthropic?.apiKey;
    const after = Date.now();
    const claims = verifyProviderToken(token, before);

    expect(claims).not.toBeNull();
    expectLifetime(claims!.exp, [before, after], ttlMs);
  });

  test.each([
    ["default", undefined, 6 * 60 * 60 * 1000],
    ["maximum", String(7 * 24 * 60 * 60 * 1000), 7 * 24 * 60 * 60 * 1000],
    ["custom", "60000", 60_000],
  ] as const)("configured %s tool TTL is the signed-token lifetime ceiling", async (_name, rawTtl, ttlMs) => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    if (rawTtl === undefined) delete process.env.TOOL_GATEWAY_TOKEN_TTL_MS;
    else process.env.TOOL_GATEWAY_TOKEN_TTL_MS = rawTtl;
    const context = ctx();
    context.threadId = `thread-tool-lifetime-${_name}`;
    context.runId = `run-tool-lifetime-${_name}`;
    const { sandbox, files } = recordingSandbox();

    const before = Date.now();
    await prepareProviderGatewaySandbox(sandbox, context, "claude");
    const after = Date.now();
    const config = JSON.parse(files["/tmp/skynet-claude-config/skynet-mcp.json"]!) as {
      mcpServers: Record<string, { headers: { Authorization: string } }>;
    };
    const token = config.mcpServers["skynet-knowledge"]!.headers.Authorization.replace(/^Bearer /, "");
    const claims = verifyToolToken(token, before);

    expect(claims).not.toBeNull();
    expectLifetime(claims!.exp, [before, after], ttlMs);
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

  test("warm turns reuse the same bounded provider token for the same identity", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const first = ctx();
    first.threadId = "thread-provider-warm-reuse";
    first.runId = "run-provider-warm-a";
    const second = ctx();
    second.threadId = first.threadId;
    second.runId = "run-provider-warm-b";

    const firstToken = opencodeProviderGatewayOptions(first).openai?.apiKey;
    const secondToken = opencodeProviderGatewayOptions(second).openai?.apiKey;

    expect(secondToken).toBe(firstToken);
    expect(verifyProviderToken(secondToken)).toMatchObject({
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-provider-warm-reuse",
      issuedRunId: "run-provider-warm-a",
      scope: "thread",
    });
  });

  test("OpenCode thread provider tokens are isolated by organization", () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    const first = ctx();
    first.threadId = "thread-provider-org-key";
    first.runId = "run-provider-org-a";
    first.orgId = "org-a";
    first.userId = "user-shared";
    const second = ctx();
    second.threadId = "thread-provider-org-key";
    second.runId = "run-provider-org-b";
    second.orgId = "org-b";
    second.userId = "user-shared";

    const firstToken = opencodeProviderGatewayOptions(first).openai?.apiKey;
    const secondToken = opencodeProviderGatewayOptions(second).openai?.apiKey;

    expect(firstToken).not.toBe(secondToken);
    expect(verifyProviderToken(firstToken)).toMatchObject({
      orgId: "org-a",
      userId: "user-shared",
      issuedRunId: "run-provider-org-a",
      scope: "thread",
    });
    expect(verifyProviderToken(secondToken)).toMatchObject({
      orgId: "org-b",
      userId: "user-shared",
      issuedRunId: "run-provider-org-b",
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

  test("Codex MCP tool tokens written to config are isolated by organization", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.TOOL_GATEWAY_SECRET = "tool-test-0123456789abcdef0123456789abcdef";
    const first = ctx();
    first.threadId = "thread-tool-org-key";
    first.runId = "run-tool-org-a";
    first.orgId = "org-a";
    first.userId = "user-shared";
    first.model = "gpt-5.6-sol";
    const second = ctx();
    second.threadId = "thread-tool-org-key";
    second.runId = "run-tool-org-b";
    second.orgId = "org-b";
    second.userId = "user-shared";
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
      orgId: "org-a",
      userId: "user-shared",
      runId: "run-tool-org-a",
      scope: "thread",
    });
    expect(verifyToolToken(secondBearer)).toMatchObject({
      orgId: "org-b",
      userId: "user-shared",
      runId: "run-tool-org-b",
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

  test("compatibility sandboxes cannot survive a gateway-only transition", async () => {
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
    process.env.NODE_ENV = "development";
    process.env.SANDBOX_SECRET_MODE = "compatibility";
    const compatibilityLabels = providerGatewaySandboxLabels("run-compatibility");
    expect(compatibilityLabels["skynet-provider-generation"]).toBe(
      "provider-gateway-v15-compatibility-secrets",
    );

    process.env.SANDBOX_SECRET_MODE = "gateway_only";
    let shellChecks = 0;
    const retained = {
      labels: compatibilityLabels,
      process: {
        executeCommand: async () => {
          shellChecks++;
          return { exitCode: 0 };
        },
      },
    } as unknown as SandboxHandle;

    expect(await providerGatewaySandboxIsCurrent(retained)).toBe(false);
    expect(shellChecks).toBe(0);
    expect(providerGatewaySandboxLabels("run-gateway")["skynet-provider-generation"]).toBe(
      SANDBOX_GENERATION,
    );
  });
});
