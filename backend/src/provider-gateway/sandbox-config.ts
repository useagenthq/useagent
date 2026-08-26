import type { EngineId } from "../db/schema";
import type { EngineRunContext } from "../engines/types";
import type { SandboxHandle } from "../sandboxes/provider";
import { providerGatewayConfig, PROVIDER_GATEWAY_PATH } from "./config";
import { type ProviderId } from "./provider";
import { mintProviderToken } from "./token";
import { DEFAULT_CODEX_MODEL } from "../runs/model-policy";
import {
  THREAD_TOKEN_REUSE_WINDOW_MS,
  ThreadTokenMemo,
  threadTokenMemoOptions,
} from "../util/token-memo";
import { toolGatewayConfig } from "../knowledge/gateway/config";
import {
  buildToolGatewayCapabilityDescriptor,
  describeToolGatewayCapabilityDescriptor,
  toCodexToolGatewayConfig,
  type ToolGatewayCapabilityDescriptor,
} from "../knowledge/gateway/descriptor";
import { sandboxSecretMode, type SandboxSecretMode } from "../secrets/inject";

export interface OpenCodeProviderOptions {
  readonly baseURL: string;
  readonly apiKey: string;
}

// v15 replaces every retained sandbox created before secret delivery mode was
// part of the trusted control-plane generation. In particular, an older v14
// sandbox may have been created in compatibility mode while carrying the same
// label as gateway-only. Separate generations also prevent a resident process
// with inherited raw secrets from surviving a compatibility -> gateway-only
// transition; replacing only files and rc hooks would not clear process env.
export const SANDBOX_GENERATION = "provider-gateway-v15-gateway-only-secrets";
const COMPATIBILITY_SANDBOX_GENERATION = "provider-gateway-v15-compatibility-secrets";
export const SANDBOX_GENERATION_LABEL = "skynet-provider-generation";
const SANDBOX_MARKER = "$HOME/.skynet/provider-gateway-generation";
const ANTHROPIC_TOKEN_FILE = "$HOME/.skynet/provider-anthropic.token";
const OPENAI_TOKEN_FILE = "$HOME/.skynet/provider-openai.token";
const CLAUDE_CONFIG_DIR = "/tmp/skynet-claude-config";
const CLAUDE_MCP_CONFIG_FILE = `${CLAUDE_CONFIG_DIR}/skynet-mcp.json`;
const CLAUDE_ONE_MILLION_CONTEXT_MODELS = new Set([
  "claude-opus-5",
  "claude-sonnet-5",
]);

function sandboxGeneration(mode: SandboxSecretMode = sandboxSecretMode()): string {
  return mode === "gateway_only" ? SANDBOX_GENERATION : COMPATIBILITY_SANDBOX_GENERATION;
}

function mint(ctx: EngineRunContext, engine: EngineId, provider: ProviderId): string | null {
  const config = providerGatewayConfig();
  if (!config || !ctx.orgId) return null;
  return mintProviderToken(
    {
      orgId: ctx.orgId,
      userId: ctx.userId ?? "",
      threadId: ctx.threadId ?? ctx.runId,
      issuedRunId: ctx.runId,
      engine,
      provider,
    },
    config.tokenTtlMs,
  );
}

// Thread-scoped tokens for the resident OpenCode runtime (perf run-invariant-
// config slice), memoized so warm turns reuse identical bytes and the sandbox
// config stays byte-stable. The gateway resolves the thread's LIVE run per
// request, so outside a running turn the token is inert - the exact-run
// enforcement moved server-side, it did not weaken. The configured TTL is the
// signed lifetime ceiling; a bounded reuse window is reserved inside it.
const residentThreadTokens = new ThreadTokenMemo();
const toolThreadTokens = new ThreadTokenMemo();

function mintResidentThreadToken(
  ctx: EngineRunContext,
  engine: "claude" | "opencode" | "pi",
  provider: ProviderId,
): string | null {
  const config = providerGatewayConfig();
  if (!config || !ctx.orgId) return null;
  const orgId = ctx.orgId;
  const userId = ctx.userId ?? "";
  // No thread → single-shot run: a memoized thread token buys nothing, keep the
  // strict exact-run binding.
  if (!ctx.threadId) return mint(ctx, engine, provider);
  const threadId = ctx.threadId;
  return residentThreadTokens.get(
    `${orgId}:${userId}:${threadId}:${engine}:${provider}`,
    threadTokenMemoOptions(config.tokenTtlMs, THREAD_TOKEN_REUSE_WINDOW_MS),
    () =>
      mintProviderToken(
        {
          orgId,
          userId,
          threadId,
          issuedRunId: ctx.runId,
          engine,
          provider,
          scope: "thread",
        },
        config.tokenTtlMs,
      ),
  );
}

export function providerGatewayEndpoint(provider: ProviderId, versioned: boolean): string | null {
  const config = providerGatewayConfig();
  if (!config) return null;
  return `${config.publicUrl}${PROVIDER_GATEWAY_PATH}/${provider}${versioned ? "/v1" : ""}`;
}

function toolGatewayDescriptor(
  ctx: EngineRunContext,
  engine: "claude" | "codex" | "pi",
): ToolGatewayCapabilityDescriptor | null {
  const config = toolGatewayConfig();
  const orgId = ctx.orgId?.trim();
  if (!config || !orgId) return null;
  const binding = {
    orgId,
    userId: ctx.userId ?? "",
    threadId: ctx.threadId ?? ctx.runId,
    runId: ctx.runId,
  };
  if (!ctx.threadId) {
    return buildToolGatewayCapabilityDescriptor(binding, { config });
  }

  const ttlMs = config.tokenTtlMs;
  const nowMs = Date.now();
  const bearerToken = toolThreadTokens.get(
    `${orgId}:${ctx.userId ?? ""}:${ctx.threadId}:${engine}:tools`,
    threadTokenMemoOptions(ttlMs, THREAD_TOKEN_REUSE_WINDOW_MS),
    () => {
      const descriptor = buildToolGatewayCapabilityDescriptor(binding, {
        config,
        scope: "thread",
        ttlMs,
        nowMs,
      });
      if (!descriptor) throw new Error(`tool gateway could not mint ${engine} capability`);
      return descriptor.bearerToken;
    },
    nowMs,
  );
  return describeToolGatewayCapabilityDescriptor(binding, {
    config,
    scope: "thread",
    bearerToken,
    expiresAt: nowMs + ttlMs,
  });
}

/** Trusted-host descriptor for subscription-backed Codex. The caller must keep
 * the bearer token out of sandbox files and client-visible provider settings. */
export function codexToolGatewayDescriptor(
  ctx: EngineRunContext,
): ToolGatewayCapabilityDescriptor | null {
  return toolGatewayDescriptor(ctx, "codex");
}

/** Backend-owned native MCP configuration for the Pi RPC process. The bearer
 * is passed only through Pi's MCP config file, never through model-visible text. */
export function piToolGatewayDescriptor(
  ctx: EngineRunContext,
): ToolGatewayCapabilityDescriptor | null {
  return toolGatewayDescriptor(ctx, "pi");
}

export interface PiProviderGatewayCapability {
  readonly provider: ProviderId;
  readonly baseUrl: string;
  readonly bearerToken: string;
}

/** Thread-scoped provider capability for a resident Pi process. */
export function piProviderGatewayCapability(
  ctx: EngineRunContext,
  provider: ProviderId,
): PiProviderGatewayCapability | null {
  const baseUrl = providerGatewayEndpoint(provider, provider !== "anthropic");
  const bearerToken = mintResidentThreadToken(ctx, "pi", provider);
  return baseUrl && bearerToken ? { provider, baseUrl, bearerToken } : null;
}

function claudeMcpConfig(descriptor: ToolGatewayCapabilityDescriptor | null): string {
  return JSON.stringify({
    mcpServers: descriptor
      ? {
          [descriptor.serverName]: {
            type: "http",
            url: descriptor.url,
            headers: { Authorization: descriptor.authorizationHeader },
          },
        }
      : {},
  });
}

/** Non-secret process configuration for resident ACP or one-shot CLI processes. */
export function providerGatewayEnv(
  ctx: EngineRunContext,
  engine: EngineId,
): Record<string, string> {
  if (engine === "codex") {
    return {};
  }
  if (engine !== "claude" && engine !== "claude-sdk") return {};
  return claudeProviderGatewayEnvironment(ctx.model);
}

/** Stable, non-secret Claude process configuration. Provider capabilities stay
 * in the private helper file and are refreshed per run. */
export function claudeProviderGatewayEnvironment(model?: string): Record<string, string> {
  const baseUrl = providerGatewayEndpoint("anthropic", false);
  if (!baseUrl) return {};
  const selectedModel = model?.trim() || "claude-opus-5";
  // Claude Code's documented `[1m]` selector is local model metadata only; it
  // strips the suffix before calling the Anthropic-compatible gateway. Keep the
  // durable run/model policy on the canonical API model id while making the
  // runtime honor the model's real context window without disabling compaction.
  const runtimeModel = CLAUDE_ONE_MILLION_CONTEXT_MODELS.has(selectedModel)
    ? `${selectedModel}[1m]`
    : selectedModel;
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    // The snapshot's user-level Claude plugins/skills are neither tenant-owned
    // nor bounded. A dedicated config root keeps the managed process deterministic;
    // project CLAUDE.md instructions and selected useAgent instructions still load.
    CLAUDE_CONFIG_DIR,
    ANTHROPIC_MODEL: runtimeModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: runtimeModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: runtimeModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: runtimeModel,
    CLAUDE_CODE_SUBAGENT_MODEL: runtimeModel,
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "1",
  };
}

/** OpenCode providers are pre-wired so a warm thread can switch models. */
export function opencodeProviderGatewayOptions(
  ctx: EngineRunContext,
): Partial<Record<ProviderId, OpenCodeProviderOptions>> {
  const anthropicToken = mintResidentThreadToken(ctx, "opencode", "anthropic");
  const openaiToken = mintResidentThreadToken(ctx, "opencode", "openai");
  const openrouterToken = mintResidentThreadToken(ctx, "opencode", "openrouter");
  // OpenCode passes provider options directly to the AI SDK; provider baseURLs
  // include `/v1` for the SDK-specific endpoint suffixes. Claude Code's
  // ANTHROPIC_BASE_URL seam differs and appends `/v1/messages` itself.
  const anthropicBase = providerGatewayEndpoint("anthropic", true);
  const openaiBase = providerGatewayEndpoint("openai", true);
  const openrouterBase = providerGatewayEndpoint("openrouter", true);
  return {
    ...(anthropicToken && anthropicBase
      ? { anthropic: { baseURL: anthropicBase, apiKey: anthropicToken } }
      : {}),
    ...(openaiToken && openaiBase
      ? { openai: { baseURL: openaiBase, apiKey: openaiToken } }
      : {}),
    ...(openrouterToken && openrouterBase
      ? { openrouter: { baseURL: openrouterBase, apiKey: openrouterToken } }
      : {}),
  };
}

export function providerGatewayWired(): boolean {
  return providerGatewayConfig() !== null;
}

/** Daytona control-plane metadata cannot be modified by code running inside the
 * sandbox, so this—not the diagnostic file marker—is the credential-generation
 * trust anchor used for warm reuse. */
export function providerGatewaySandboxLabels(runId: string): Record<string, string> {
  return {
    "skynet-run": runId,
    ...(providerGatewayWired()
      ? { [SANDBOX_GENERATION_LABEL]: sandboxGeneration() }
      : {}),
  };
}

/** User-level Codex config; unlike OPENAI_BASE_URL, this seam is explicitly supported. */
export function codexProviderConfigToml(
  model: string,
  toolGateway?: { readonly url: string; readonly bearerToken: string },
): string | null {
  const baseUrl = providerGatewayEndpoint("openai", true);
  if (!baseUrl) return null;
  return [
    `model = ${JSON.stringify(model)}`,
    'model_provider = "skynet"',
    // Codex normally adds a Linux bubblewrap sandbox around every command. The
    // agent already runs inside its tenant-scoped Daytona sandbox, where nested
    // namespace/loopback setup is not permitted and fails intermittently. Disable
    // only that redundant INNER sandbox; this config is materialized inside
    // Daytona and grants no access to the trusted useAgent host/control plane.
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    "",
    "[model_providers.skynet]",
    'name = "useAgent provider gateway"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
    "[model_providers.skynet.auth]",
    'command = "sh"',
    `args = ["-c", ${JSON.stringify(`cat \"${OPENAI_TOKEN_FILE}\"`)}]`,
    "refresh_interval_ms = 1",
    "timeout_ms = 5000",
    "",
    ...(toolGateway
      ? [
          "[mcp_servers.skynet-knowledge]",
          `url = ${JSON.stringify(toolGateway.url)}`,
          `http_headers = { Authorization = ${JSON.stringify(`Bearer ${toolGateway.bearerToken}`)} }`,
          "enabled = true",
          "required = true",
          'default_tools_approval_mode = "auto"',
          "",
        ]
      : []),
  ].join("\n");
}

async function readJsonFile(sandbox: SandboxHandle, path: string): Promise<Record<string, unknown>> {
  const result = await sandbox.process
    .executeCommand(`cat ${path} 2>/dev/null || true`, undefined, undefined, 10)
    .catch(() => null);
  const raw = result?.result?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function writePrivateFiles(
  sandbox: SandboxHandle,
  files: readonly { readonly path: string; readonly content: string }[],
): Promise<void> {
  const writes = files.map(({ path, content }) => {
    const encoded = Buffer.from(content, "utf8").toString("base64");
    return `printf %s '${encoded}' | base64 -d > ${path} && chmod 600 ${path}`;
  });
  const result = await sandbox.process.executeCommand(
    `mkdir -p $HOME/.skynet $HOME/.claude $HOME/.codex ${CLAUDE_CONFIG_DIR} && ` +
      `chmod 700 $HOME/.skynet ${CLAUDE_CONFIG_DIR} && ${writes.join(" && ")}`,
    undefined,
    undefined,
    20,
  );
  if ((result.exitCode ?? 1) !== 0) throw new Error("failed to configure provider gateway");
}

/** Rewrite the exact current run capability without restarting the resident agent. */
export async function prepareProviderGatewaySandbox(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
  engine: "claude" | "codex",
): Promise<void> {
  if (!providerGatewayWired()) return;
  const generation = sandboxGeneration();
  if (engine === "claude") {
    const token = mintResidentThreadToken(ctx, "claude", "anthropic");
    if (!token) throw new Error("provider gateway could not mint Claude capability");
    const settings = await readJsonFile(sandbox, `${CLAUDE_CONFIG_DIR}/settings.json`);
    settings.apiKeyHelper = `cat \"${ANTHROPIC_TOKEN_FILE}\"`;
    const toolDescriptor = toolGatewayDescriptor(ctx, "claude");
    await writePrivateFiles(sandbox, [
      { path: ANTHROPIC_TOKEN_FILE, content: token },
      { path: `${CLAUDE_CONFIG_DIR}/settings.json`, content: JSON.stringify(settings) },
      { path: CLAUDE_MCP_CONFIG_FILE, content: claudeMcpConfig(toolDescriptor) },
      { path: SANDBOX_MARKER, content: generation },
    ]);
    return;
  }

  const token = mint(ctx, "codex", "openai");
  const toolDescriptor = toolGatewayDescriptor(ctx, "codex");
  const config = codexProviderConfigToml(
    ctx.model?.trim() || DEFAULT_CODEX_MODEL,
    toolDescriptor ? toCodexToolGatewayConfig(toolDescriptor) : undefined,
  );
  if (!token || !config) throw new Error("provider gateway could not mint Codex capability");
  await writePrivateFiles(sandbox, [
    { path: OPENAI_TOKEN_FILE, content: token },
    { path: "$HOME/.codex/config.toml", content: config },
    { path: SANDBOX_MARKER, content: generation },
  ]);
  // Never let a snapshot or prior dev turn's host login override command-backed auth.
  const removal = await sandbox.process.executeCommand(
    "rm -f $HOME/.codex/auth.json",
    undefined,
    undefined,
    10,
  );
  if ((removal.exitCode ?? 1) !== 0) {
    throw new Error("failed to remove legacy Codex authentication");
  }
}

/** Old warm sandboxes may still contain raw provider env; never reuse them. */
export async function providerGatewaySandboxIsCurrent(sandbox: SandboxHandle): Promise<boolean> {
  if (!providerGatewayWired()) return true;
  const generation = sandboxGeneration();
  const labels = (sandbox as { labels?: Record<string, string> }).labels;
  if (labels?.[SANDBOX_GENERATION_LABEL] !== generation) return false;
  const result = await sandbox.process
    .executeCommand(`test \"$(cat ${SANDBOX_MARKER} 2>/dev/null)\" = \"${generation}\"`, undefined, undefined, 10)
    .catch(() => null);
  return result?.exitCode === 0;
}

/** OpenCode writes its own dynamic provider config, but shares the generation marker. */
export async function markProviderGatewaySandboxCurrent(sandbox: SandboxHandle): Promise<void> {
  if (!providerGatewayWired()) return;
  await writePrivateFiles(sandbox, [
    { path: SANDBOX_MARKER, content: sandboxGeneration() },
  ]);
}
