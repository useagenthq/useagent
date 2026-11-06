import { SANDBOX_NAME_PREFIX, SANDBOX_STATE_HOME } from "../sandboxes/sandbox-names";
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
import {
  CANONICAL_SANDBOX_GENERATION_LABEL,
  CANONICAL_SANDBOX_RUN_LABEL,
  LEGACY_SANDBOX_GENERATION_LABEL,
  LEGACY_SANDBOX_RUN_LABEL,
  readCompatibleSandboxLabel,
} from "../sandboxes/label-compat";
export type { CompatibleSandboxLabel } from "../sandboxes/label-compat";
export {
  CANONICAL_SANDBOX_GENERATION_LABEL,
  CANONICAL_SANDBOX_RUN_LABEL,
  LEGACY_SANDBOX_GENERATION_LABEL,
  LEGACY_SANDBOX_RUN_LABEL,
  readCompatibleSandboxLabel,
} from "../sandboxes/label-compat";

export interface OpenCodeProviderOptions {
  readonly baseURL: string;
  readonly apiKey: string;
}

// The context of each Anthropic model OpenCode may run (models.dev, Oct 2026).
// Its catalog gives every one but Claude Haiku 4.5 128,000 output tokens, past
// the gateway's per-request ceiling (limits.ts), which refuses such a call
// (output_limit_exceeded) before it is sent: OpenCode asks for all of it.
const OPENCODE_ANTHROPIC_CONTEXT: Readonly<Record<string, number>> = {
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

/** The most output an engine asks an Anthropic model for (OpenCode's model
 *  limit, Claude Code's CLAUDE_CODE_MAX_OUTPUT_TOKENS): under the gateway's
 *  default ceiling (limits.ts; its test holds the two apart). */
export const ANTHROPIC_ENGINE_OUTPUT_TOKENS = 64_000;

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
  if (provider === "anthropic") {
    const existingModels = existing.models && typeof existing.models === "object"
      ? existing.models as Record<string, unknown>
      : {};
    return {
      ...existing,
      // OpenCode takes a model's limit whole (context and output), on top of its catalog entry.
      models: {
        ...existingModels,
        ...Object.fromEntries(Object.entries(OPENCODE_ANTHROPIC_CONTEXT).map(([id, context]) =>
          [id, { limit: { context, output: ANTHROPIC_ENGINE_OUTPUT_TOKENS } }])),
      },
      options: { ...existingOptions, ...options },
    };
  }
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
export const SANDBOX_GENERATION_LABEL = CANONICAL_SANDBOX_GENERATION_LABEL;
const LEGACY_SANDBOX_MARKER = `${SANDBOX_STATE_HOME}/provider-gateway-generation`;
const CANONICAL_SANDBOX_MARKER = "$HOME/.useagent/provider-gateway-generation";
const SANDBOX_MARKER = CANONICAL_SANDBOX_MARKER;
const LEGACY_OPENAI_TOKEN_FILE = `${SANDBOX_STATE_HOME}/provider-openai.token`;
const CANONICAL_OPENAI_TOKEN_FILE = "$HOME/.useagent/provider-openai.token";
const OPENAI_TOKEN_FILE = CANONICAL_OPENAI_TOKEN_FILE;
/** Claude Code keeps its sessions here; retained sandboxes resume from it. */
export const CLAUDE_CONFIG_DIR = `/tmp/${SANDBOX_NAME_PREFIX}-claude-config`;
/** Codex records the provider id on every session it starts; retained sessions resume under it. */
const CODEX_MODEL_PROVIDER_ID = SANDBOX_NAME_PREFIX;
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

function sandboxGeneration(mode: SandboxSecretMode = sandboxSecretMode()): string {
  return mode === "gateway_only" ? SANDBOX_GENERATION : COMPATIBILITY_SANDBOX_GENERATION;
}

function readPresentCanonicalOrLegacyFile(canonical: string, legacy: string): string {
  return `if [ -e "${canonical}" ] || [ -L "${canonical}" ]; then file="${canonical}"; else file="${legacy}"; fi; test -r "$file" && test -s "$file" && cat "$file"`;
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

export function toolGatewayDescriptor(
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

export function claudeMcpConfig(descriptor: ToolGatewayCapabilityDescriptor | null): string {
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
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    // The snapshot's user-level Claude plugins/skills are neither tenant-owned
    // nor bounded. A dedicated config root keeps the managed process deterministic;
    // project CLAUDE.md instructions and selected useAgent instructions still load.
    CLAUDE_CONFIG_DIR,
    ...claudeModelSlots(model),
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "1",
  };
}

/** Every Claude Code model slot names the run's model, so its Haiku helper and
 *  subagent calls ask the gateway for that model too: it refuses any other. */
function claudeModelSlots(model?: string): Record<string, string> {
  const selectedModel = model?.trim() || "claude-opus-5";
  // Claude Code's documented `[1m]` selector is local model metadata only; it
  // strips the suffix before calling the Anthropic-compatible gateway. Keep the
  // durable run/model policy on the canonical API model id while making the
  // runtime honor the model's real context window without disabling compaction.
  const runtimeModel = CLAUDE_ONE_MILLION_CONTEXT_MODELS.has(selectedModel)
    ? `${selectedModel}[1m]`
    : selectedModel;
  return {
    ANTHROPIC_MODEL: runtimeModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: runtimeModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: runtimeModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: runtimeModel,
    CLAUDE_CODE_SUBAGENT_MODEL: runtimeModel,
  };
}

/** OpenCode providers are pre-wired so a warm thread can switch models. */
export function opencodeProviderGatewayOptions(
  ctx: EngineRunContext,
  /** Providers PROVIDER_ACCOUNTS withholds from this run's user: no token is minted for them. */
  withheld: ReadonlySet<string> = new Set(),
): Partial<Record<ProviderId, OpenCodeProviderOptions>> {
  const mint = (provider: ProviderId) => withheld.has(provider) ? null : mintResidentThreadToken(ctx, "opencode", provider);
  const anthropicToken = mint("anthropic");
  const openaiToken = mint("openai");
  const openrouterToken = mint("openrouter");
  const cerebrasToken = mint("cerebras");
  const zenToken = mint("opencode");
  // OpenCode passes provider options directly to the AI SDK; provider baseURLs
  // include `/v1` for the SDK-specific endpoint suffixes. Claude Code's
  // ANTHROPIC_BASE_URL seam differs and appends `/v1/messages` itself.
  const anthropicBase = providerGatewayEndpoint("anthropic", true);
  const openaiBase = providerGatewayEndpoint("openai", true);
  const openrouterBase = providerGatewayEndpoint("openrouter", true);
  const cerebrasBase = providerGatewayEndpoint("cerebras", true);
  const zenBase = providerGatewayEndpoint("opencode", true);
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
    // OpenCode's own Zen provider (the free lane's second source) rides the
    // same gateway seam; its runtime adapter is OpenAI-compatible.
    ...(zenToken && zenBase
      ? { opencode: { baseURL: zenBase, apiKey: zenToken } }
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
    `model_provider = "${CODEX_MODEL_PROVIDER_ID}"`,
    // Codex normally adds a Linux bubblewrap sandbox around every command. The
    // agent already runs inside its tenant-scoped Daytona sandbox, where nested
    // namespace/loopback setup is not permitted and fails intermittently. Disable
    // only that redundant INNER sandbox; this config is materialized inside
    // Daytona and grants no access to the trusted useAgent host/control plane.
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    // Native goals let Codex start turns on its own, outside admission and spend checks.
    "features.goals = false",
    "",
    `[model_providers.${CODEX_MODEL_PROVIDER_ID}]`,
    'name = "UseAgent provider gateway"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
    `[model_providers.${CODEX_MODEL_PROVIDER_ID}.auth]`,
    'command = "sh"',
    `args = ["-c", ${JSON.stringify(readPresentCanonicalOrLegacyFile(
      CANONICAL_OPENAI_TOKEN_FILE,
      LEGACY_OPENAI_TOKEN_FILE,
    ))}]`,
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

export async function writePrivateFiles(
  sandbox: SandboxHandle,
  files: readonly { readonly path: string; readonly content: string }[],
  /** Shell steps that run after the writes in the same command. */
  after: readonly string[] = [],
): Promise<void> {
  const compatibilityAliases: Readonly<Record<string, { legacy: string; relativeTarget: string }>> = {
    [CANONICAL_OPENAI_TOKEN_FILE]: {
      legacy: LEGACY_OPENAI_TOKEN_FILE,
      relativeTarget: "../.useagent/provider-openai.token",
    },
    [CANONICAL_SANDBOX_MARKER]: {
      legacy: LEGACY_SANDBOX_MARKER,
      relativeTarget: "../.useagent/provider-gateway-generation",
    },
  };
  const temporaryPaths: string[] = [];
  const aliasedFiles = files.filter(({ path }) => compatibilityAliases[path]);
  const leafChecks = aliasedFiles.flatMap(({ path }) => {
    const alias = compatibilityAliases[path];
    if (!alias) return [];
    return [path, alias.legacy].map(
      (leaf) => `if [ -d ${leaf} ] && [ ! -L ${leaf} ]; then exit 1; fi`,
    );
  });
  const writes = files.map(({ path, content }) => {
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const alias = compatibilityAliases[path];
    if (alias) {
      const leaf = path.slice(path.lastIndexOf("/") + 1);
      const canonicalTemporary = `$HOME/.useagent/.${leaf}-${crypto.randomUUID()}.tmp`;
      const legacyTemporary = `${SANDBOX_STATE_HOME}/.${leaf}-${crypto.randomUUID()}.tmp`;
      temporaryPaths.push(canonicalTemporary, legacyTemporary);
      return [
        `(umask 077; printf %s '${encoded}' | base64 -d > ${canonicalTemporary})`,
        `chmod 600 ${canonicalTemporary}`,
        `node -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' ${canonicalTemporary} ${path}`,
        `ln -s ${alias.relativeTarget} ${legacyTemporary}`,
        `node -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' ${legacyTemporary} ${alias.legacy}`,
        `node -e 'const f=require("node:fs"),c=process.argv[1],l=process.argv[2],t=process.argv[3],s=f.lstatSync(c);if(!s.isFile()||s.isSymbolicLink()||(s.mode&511)!==384||!f.lstatSync(l).isSymbolicLink()||f.readlinkSync(l)!==t)process.exit(1)' ${path} ${alias.legacy} ${alias.relativeTarget}`,
      ].join(" && ");
    }
    return `printf %s '${encoded}' | base64 -d > ${path} && chmod 600 ${path}`;
  });
  const result = await sandbox.process.executeCommand(
    [
      `trap 'rm -f -- ${temporaryPaths.join(" ")} 2>/dev/null || true' EXIT`,
      `if [ -L ${SANDBOX_STATE_HOME} ] || [ -L $HOME/.useagent ]; then exit 1; fi`,
      `if [ -e ${SANDBOX_STATE_HOME} ]; then test -d ${SANDBOX_STATE_HOME}; else mkdir -m 700 ${SANDBOX_STATE_HOME}; fi`,
      "if [ -e $HOME/.useagent ]; then test -d $HOME/.useagent; else mkdir -m 700 $HOME/.useagent; fi",
      "mkdir -p $HOME/.claude $HOME/.codex",
      ...leafChecks,
      ...writes,
      ...after,
    ].join(" && "),
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

export async function writeClaudeCapabilityFiles(
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

export async function writeUserClaudeCapabilityFiles(
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

/** The `--settings` file the Claude wrapper passes, rewritten every turn: the
 *  wrapper exports only the gateway URL and config dir, so per-run process
 *  settings, the run's model slots among them, ride here. Claude Code's own
 *  output default for the 1M-context models (128K) is past the gateway's
 *  ceiling, which refused every call. */
function claudeManagedSettings(model: string | undefined): Record<string, unknown> {
  return {
    apiKeyHelper: `cat \"${ANTHROPIC_TOKEN_FILE}\"`,
    env: {
      ...claudeModelSlots(model),
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(ANTHROPIC_ENGINE_OUTPUT_TOKENS),
    },
  };
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
    const managedSettings = claudeManagedSettings(ctx.model);
    const toolDescriptor = toolGatewayDescriptor(ctx, "claude");
    const files = [
      { path: ANTHROPIC_TOKEN_FILE, content: token },
      { path: CLAUDE_ACP_SETTINGS_FILE, content: JSON.stringify(managedSettings) },
      { path: CLAUDE_SETTINGS_FILE, content: JSON.stringify(managedSettings) },
      { path: CLAUDE_MCP_CONFIG_FILE, content: claudeMcpConfig(toolDescriptor) },
    ];
    await Promise.all([
      options.rootOwnedClaudeCapability
        ? writeClaudeCapabilityFiles(sandbox, files)
        : writeUserClaudeCapabilityFiles(sandbox, files),
      writePrivateFiles(sandbox, [{ path: SANDBOX_MARKER, content: generation }]),
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
  // Never let a snapshot or prior dev turn's host login override command-backed
  // auth: the removal rides the same command as the writes, one round trip.
  await writePrivateFiles(
    sandbox,
    [
      { path: OPENAI_TOKEN_FILE, content: token },
      { path: "$HOME/.codex/config.toml", content: config },
      { path: SANDBOX_MARKER, content: generation },
    ],
    ["rm -f $HOME/.codex/auth.json"],
  );
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
  const markerRead = readPresentCanonicalOrLegacyFile(
    CANONICAL_SANDBOX_MARKER,
    LEGACY_SANDBOX_MARKER,
  );
  const result = await sandbox.process
    .executeCommand(`test \"$(${markerRead} 2>/dev/null)\" = \"${generation}\"`, undefined, undefined, 10)
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
