import type { EngineId } from "../db/schema";
import type { EngineRunContext } from "../engines/types";
import type { SandboxHandle } from "../sandboxes/provider";
import { providerGatewayConfig, PROVIDER_GATEWAY_PATH } from "./config";
import { type ProviderId } from "./provider";
import { mintProviderToken } from "./token";
import {
  CEREBRAS_GEMMA_MODEL,
  CEREBRAS_QWEN_MODEL,
  DEFAULT_CODEX_MODEL,
} from "../runs/model-policy";
import {
  THREAD_TOKEN_REUSE_WINDOW_MS,
  ThreadTokenMemo,
  threadTokenMemoOptions,
} from "../util/token-memo";
import { toolGatewayConfig } from "../knowledge/gateway/config";
import {
  buildToolGatewayCapabilityDescriptor,
  describeToolGatewayCapabilityDescriptor,
  TOOL_GATEWAY_SERVER_NAME,
  toCodexToolGatewayConfig,
  type ToolGatewayCapabilityDescriptor,
} from "../knowledge/gateway/descriptor";
import { sandboxSecretMode, type SandboxSecretMode } from "../secrets/inject";

export interface OpenCodeProviderOptions {
  readonly baseURL: string;
  readonly apiKey: string;
}

export function mergeOpenCodeProviderConfig(
  provider: string,
  current: unknown,
  options: OpenCodeProviderOptions,
): Record<string, unknown> {
  const existing = current && typeof current === "object"
    ? current as Record<string, unknown>
    : {};
  const existingOptions = existing.options && typeof existing.options === "object"
    ? existing.options as Record<string, unknown>
    : {};
  if (provider !== "cerebras") {
    return { ...existing, options: { ...existingOptions, ...options } };
  }
  const existingModels = existing.models && typeof existing.models === "object"
    ? existing.models as Record<string, unknown>
    : {};
  return {
    ...existing,
    npm: "@ai-sdk/cerebras",
    name: "Cerebras",
    models: {
      ...existingModels,
      [CEREBRAS_QWEN_MODEL.slice("cerebras/".length)]: {
        name: "Qwen 3.8 27B",
        limit: { context: 65_536, output: 16_384 },
      },
      // Existing durable Gemma threads may still resume or receive replies.
      [CEREBRAS_GEMMA_MODEL.slice("cerebras/".length)]: {
        name: "Gemma 4 31B",
        limit: { context: 131_072, output: 40_960 },
      },
    },
    options: { ...existingOptions, ...options },
  };
}

// v17 replaces retained sandboxes whose resident harnesses still expose the
// retired MCP server ids. A generation boundary makes both forward deployment
// and rollback converge on one config instead of accumulating duplicate tools.
// Separate variants still prevent a resident process with inherited raw secrets
// from surviving a compatibility -> gateway-only transition.
export const SANDBOX_GENERATION = "provider-gateway-v17-useagent-mcp-gateway-only-secrets";
const COMPATIBILITY_SANDBOX_GENERATION = "provider-gateway-v17-useagent-mcp-compatibility-secrets";
export const CANONICAL_SANDBOX_RUN_LABEL = "useagent-run";
export const LEGACY_SANDBOX_RUN_LABEL = "skynet-run";
export const CANONICAL_SANDBOX_GENERATION_LABEL = "useagent-provider-generation";
export const LEGACY_SANDBOX_GENERATION_LABEL = "skynet-provider-generation";
export const SANDBOX_GENERATION_LABEL = CANONICAL_SANDBOX_GENERATION_LABEL;
const SANDBOX_MARKER = "$HOME/.skynet/provider-gateway-generation";
const OPENAI_TOKEN_FILE = "$HOME/.skynet/provider-openai.token";
export const CLAUDE_CONFIG_DIR = "/tmp/skynet-claude-config";
export const CLAUDE_CAPABILITY_DIR = "/tmp/useagent-claude-capability";
export const CLAUDE_CAPABILITY_GID = 1000;
export const CLAUDE_ACP_SETTINGS_FILE = `${CLAUDE_CAPABILITY_DIR}/settings.json`;
export const CLAUDE_SETTINGS_FILE = `${CLAUDE_CAPABILITY_DIR}/useagent-settings.json`;
export const CLAUDE_MCP_CONFIG_FILE = `${CLAUDE_CAPABILITY_DIR}/useagent-mcp.json`;
const ANTHROPIC_TOKEN_FILE = `${CLAUDE_CAPABILITY_DIR}/provider-anthropic.token`;
const CLAUDE_ONE_MILLION_CONTEXT_MODELS = new Set([
  "claude-opus-5",
  "claude-sonnet-5",
]);

export interface CompatibleSandboxLabel {
  readonly value: string | null;
  readonly conflict: boolean;
}

export function readCompatibleSandboxLabel(
  labels: Readonly<Record<string, string>>,
  canonicalKey: string,
  legacyKey: string,
): CompatibleSandboxLabel {
  const canonical = labels[canonicalKey];
  const legacy = labels[legacyKey];
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
    return { value: null, conflict: true };
  }
  return { value: canonical ?? legacy ?? null, conflict: false };
}

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
  const cerebrasToken = mintResidentThreadToken(ctx, "opencode", "cerebras");
  // OpenCode passes provider options directly to the AI SDK; provider baseURLs
  // include `/v1` for the SDK-specific endpoint suffixes. Claude Code's
  // ANTHROPIC_BASE_URL seam differs and appends `/v1/messages` itself.
  const anthropicBase = providerGatewayEndpoint("anthropic", true);
  const openaiBase = providerGatewayEndpoint("openai", true);
  const openrouterBase = providerGatewayEndpoint("openrouter", true);
  const cerebrasBase = providerGatewayEndpoint("cerebras", true);
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
    ...(cerebrasToken && cerebrasBase
      ? { cerebras: { baseURL: cerebrasBase, apiKey: cerebrasToken } }
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
    [CANONICAL_SANDBOX_RUN_LABEL]: runId,
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
          `[mcp_servers.${TOOL_GATEWAY_SERVER_NAME}]`,
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

async function writePrivateFiles(
  sandbox: SandboxHandle,
  files: readonly { readonly path: string; readonly content: string }[],
): Promise<void> {
  const writes = files.map(({ path, content }) => {
    const encoded = Buffer.from(content, "utf8").toString("base64");
    return `printf %s '${encoded}' | base64 -d > ${path} && chmod 600 ${path}`;
  });
  const result = await sandbox.process.executeCommand(
    `mkdir -p $HOME/.skynet $HOME/.claude $HOME/.codex && ` +
      `chmod 700 $HOME/.skynet && ${writes.join(" && ")}`,
    undefined,
    undefined,
    20,
  );
  if ((result.exitCode ?? 1) !== 0) throw new Error("failed to configure provider gateway");
}

/** Atomically replace Claude's run capabilities inside a root-owned directory.
 * The agent uid can read these scoped files but cannot replace them with
 * symlinks before a later root refresh. */
export function buildClaudeCapabilityWriteCommand(
  directory: string,
  files: readonly { readonly path: string; readonly content: string }[],
  ownerUid = 0,
  readerGid = CLAUDE_CAPABILITY_GID,
): string {
  const temporaryPaths: string[] = [];
  const writes = files.map(({ path, content }) => {
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const temporaryPath = `${directory}/.capability-${crypto.randomUUID()}`;
    temporaryPaths.push(temporaryPath);
    return [
      `printf %s '${encoded}' | base64 -d > ${temporaryPath}`,
      `chown ${ownerUid}:${readerGid} ${temporaryPath}`,
      `chmod 440 ${temporaryPath}`,
      `node -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' ${temporaryPath} ${path}`,
    ].join(" && ");
  });
  return [
    `if [ -L ${directory} ]; then rm -f -- ${directory}; fi`,
    `install -d -o ${ownerUid} -g ${readerGid} -m 750 ${directory}`,
    `test -d ${directory} && test ! -L ${directory}`,
    ...writes,
    `rm -f -- ${temporaryPaths.join(" ")}`,
  ].join(" && ");
}

async function writeClaudeCapabilityFiles(
  sandbox: SandboxHandle,
  files: readonly { readonly path: string; readonly content: string }[],
): Promise<void> {
  const result = await sandbox.process.executeCommand(
    buildClaudeCapabilityWriteCommand(CLAUDE_CAPABILITY_DIR, files),
    undefined,
    undefined,
    20,
  );
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("failed to configure Claude provider capability");
  }
}

async function writeUserClaudeCapabilityFiles(
  sandbox: SandboxHandle,
  files: readonly { readonly path: string; readonly content: string }[],
): Promise<void> {
  const writes = files.map(({ path, content }) => {
    const encoded = Buffer.from(content, "utf8").toString("base64");
    return `printf %s '${encoded}' | base64 -d > ${path} && chmod 600 ${path}`;
  });
  const result = await sandbox.process.executeCommand(
    `mkdir -p ${CLAUDE_CAPABILITY_DIR} && chmod 700 ${CLAUDE_CAPABILITY_DIR} && ${writes.join(" && ")}`,
    undefined,
    undefined,
    20,
  );
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("failed to configure user-owned Claude provider capability");
  }
}

/** Rewrite the exact current run capability without restarting the resident agent. */
export async function prepareProviderGatewaySandbox(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
  engine: "claude" | "codex",
  options: { readonly rootOwnedClaudeCapability?: boolean } = {},
): Promise<void> {
  if (!providerGatewayWired()) return;
  const generation = sandboxGeneration();
  if (engine === "claude") {
    const token = mintResidentThreadToken(ctx, "claude", "anthropic");
    if (!token) throw new Error("provider gateway could not mint Claude capability");
    const managedSettings = { apiKeyHelper: `cat \"${ANTHROPIC_TOKEN_FILE}\"` };
    const toolDescriptor = toolGatewayDescriptor(ctx, "claude");
    const files = [
      { path: ANTHROPIC_TOKEN_FILE, content: token },
      { path: CLAUDE_ACP_SETTINGS_FILE, content: JSON.stringify(managedSettings) },
      { path: CLAUDE_SETTINGS_FILE, content: JSON.stringify(managedSettings) },
      { path: CLAUDE_MCP_CONFIG_FILE, content: claudeMcpConfig(toolDescriptor) },
    ];
    await (options.rootOwnedClaudeCapability
      ? writeClaudeCapabilityFiles(sandbox, files)
      : writeUserClaudeCapabilityFiles(sandbox, files));
    await writePrivateFiles(sandbox, [{ path: SANDBOX_MARKER, content: generation }]);
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
  const labels = (sandbox as { labels?: Record<string, string> }).labels ?? {};
  const labeledGeneration = readCompatibleSandboxLabel(
    labels,
    CANONICAL_SANDBOX_GENERATION_LABEL,
    LEGACY_SANDBOX_GENERATION_LABEL,
  );
  if (labeledGeneration.conflict || labeledGeneration.value !== generation) return false;
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
