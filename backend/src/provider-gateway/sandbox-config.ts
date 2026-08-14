import type { EngineId } from "../db/schema";
import type { EngineRunContext } from "../engines/types";
import type { SandboxHandle } from "../sandboxes/provider";
import { providerGatewayConfig, PROVIDER_GATEWAY_PATH } from "./config";
import { type ProviderId } from "./provider";
import { mintProviderToken } from "./token";
import { DEFAULT_CODEX_MODEL } from "../runs/model-policy";
import { ThreadTokenMemo } from "../util/token-memo";
import { toolGatewayConfig } from "../knowledge/gateway/config";
import { mintToolToken } from "../knowledge/gateway/token";

export interface OpenCodeProviderOptions {
  readonly baseURL: string;
  readonly apiKey: string;
}

// v12 invalidates resident Codex processes started before the trusted
// skynet-knowledge MCP was written into config.toml. ACP's session-level MCP
// descriptor is retained as a compatibility path, but native Codex must also
// receive the gateway through its supported host configuration.
export const SANDBOX_GENERATION = "provider-gateway-v12-native-computer-use";
export const SANDBOX_GENERATION_LABEL = "skynet-provider-generation";
const SANDBOX_MARKER = "$HOME/.skynet/provider-gateway-generation";
const ANTHROPIC_TOKEN_FILE = "$HOME/.skynet/provider-anthropic.token";
const OPENAI_TOKEN_FILE = "$HOME/.skynet/provider-openai.token";
const CLAUDE_CONFIG_DIR = "/tmp/skynet-claude-config";
const CLAUDE_ONE_MILLION_CONTEXT_MODELS = new Set([
  "claude-opus-5",
  "claude-sonnet-5",
]);

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
// enforcement moved server-side, it did not weaken. TTL = turn-cover TTL
// (tokenTtlMs, sized to the worker's absolute run ceiling) + a bounded reuse
// window; refresh when remaining validity drops below the turn-cover TTL, so a
// turn dispatched on a reused token has the SAME in-turn validity guarantee as
// a freshly minted run token (adversarial-review finding).
const THREAD_TOKEN_REUSE_MS = 8 * 60 * 60 * 1000;
const opencodeThreadTokens = new ThreadTokenMemo();
const codexToolThreadTokens = new ThreadTokenMemo();

function mintOpencodeThreadToken(
  ctx: EngineRunContext,
  provider: ProviderId,
): string | null {
  const config = providerGatewayConfig();
  if (!config || !ctx.orgId) return null;
  const orgId = ctx.orgId;
  const userId = ctx.userId ?? "";
  // No thread → single-shot run: a memoized thread token buys nothing, keep the
  // strict exact-run binding.
  if (!ctx.threadId) return mint(ctx, "opencode", provider);
  const threadId = ctx.threadId;
  return opencodeThreadTokens.get(
    `${orgId}:${userId}:${threadId}:opencode:${provider}`,
    { ttlMs: config.tokenTtlMs + THREAD_TOKEN_REUSE_MS, refreshMarginMs: config.tokenTtlMs },
    () =>
      mintProviderToken(
        {
          orgId,
          userId,
          threadId,
          issuedRunId: ctx.runId,
          engine: "opencode",
          provider,
          scope: "thread",
        },
        config.tokenTtlMs + THREAD_TOKEN_REUSE_MS,
      ),
  );
}

function endpoint(provider: ProviderId, versioned: boolean): string | null {
  const config = providerGatewayConfig();
  if (!config) return null;
  return `${config.publicUrl}${PROVIDER_GATEWAY_PATH}/${provider}${versioned ? "/v1" : ""}`;
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
  const baseUrl = endpoint("anthropic", false);
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
    // project CLAUDE.md instructions and selected Skynet instructions still load.
    CLAUDE_CONFIG_DIR,
    ANTHROPIC_MODEL: runtimeModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: runtimeModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: runtimeModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: runtimeModel,
    CLAUDE_CODE_SUBAGENT_MODEL: runtimeModel,
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "1",
  };
}

/** Both OpenCode providers are pre-wired so a warm thread can switch models. */
export function opencodeProviderGatewayOptions(
  ctx: EngineRunContext,
): Partial<Record<"anthropic" | "openrouter", OpenCodeProviderOptions>> {
  const anthropicToken = mintOpencodeThreadToken(ctx, "anthropic");
  const openrouterToken = mintOpencodeThreadToken(ctx, "openrouter");
  // OpenCode passes provider options directly to the AI SDK; its documented
  // Anthropic baseURL includes `/v1` (the SDK appends `/messages`). Claude Code's
  // ANTHROPIC_BASE_URL seam differs and appends `/v1/messages` itself.
  const anthropicBase = endpoint("anthropic", true);
  const openrouterBase = endpoint("openrouter", true);
  return {
    ...(anthropicToken && anthropicBase
      ? { anthropic: { baseURL: anthropicBase, apiKey: anthropicToken } }
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
    ...(providerGatewayWired() ? { [SANDBOX_GENERATION_LABEL]: SANDBOX_GENERATION } : {}),
  };
}

/** User-level Codex config; unlike OPENAI_BASE_URL, this seam is explicitly supported. */
export function codexProviderConfigToml(
  model: string,
  toolGateway?: { readonly url: string; readonly bearerToken: string },
): string | null {
  const baseUrl = endpoint("openai", true);
  if (!baseUrl) return null;
  return [
    `model = ${JSON.stringify(model)}`,
    'model_provider = "skynet"',
    // Codex normally adds a Linux bubblewrap sandbox around every command. The
    // agent already runs inside its tenant-scoped Daytona sandbox, where nested
    // namespace/loopback setup is not permitted and fails intermittently. Disable
    // only that redundant INNER sandbox; this config is materialized inside
    // Daytona and grants no access to the trusted Skynet host/control plane.
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    "",
    "[model_providers.skynet]",
    'name = "Skynet provider gateway"',
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
  if (engine === "claude") {
    const token = mint(ctx, "claude", "anthropic");
    if (!token) throw new Error("provider gateway could not mint Claude capability");
    const settings = await readJsonFile(sandbox, `${CLAUDE_CONFIG_DIR}/settings.json`);
    settings.apiKeyHelper = `cat \"${ANTHROPIC_TOKEN_FILE}\"`;
    await writePrivateFiles(sandbox, [
      { path: ANTHROPIC_TOKEN_FILE, content: token },
      { path: `${CLAUDE_CONFIG_DIR}/settings.json`, content: JSON.stringify(settings) },
      { path: SANDBOX_MARKER, content: SANDBOX_GENERATION },
    ]);
    return;
  }

  const token = mint(ctx, "codex", "openai");
  const toolConfig = toolGatewayConfig();
  const toolToken = toolConfig && ctx.orgId
    ? codexToolThreadTokens.get(
        `${ctx.orgId}:${ctx.userId ?? ""}:${ctx.threadId ?? ctx.runId}:codex:tools`,
        {
          ttlMs: toolConfig.tokenTtlMs + THREAD_TOKEN_REUSE_MS,
          refreshMarginMs: toolConfig.tokenTtlMs,
        },
        () => mintToolToken({
          orgId: ctx.orgId!,
          userId: ctx.userId ?? "",
          threadId: ctx.threadId ?? ctx.runId,
          runId: ctx.runId,
          scope: ctx.threadId ? "thread" : "run",
        }, toolConfig.tokenTtlMs + THREAD_TOKEN_REUSE_MS),
      )
    : null;
  const config = codexProviderConfigToml(
    ctx.model?.trim() || DEFAULT_CODEX_MODEL,
    toolConfig && toolToken ? { url: toolConfig.mcpUrl, bearerToken: toolToken } : undefined,
  );
  if (!token || !config) throw new Error("provider gateway could not mint Codex capability");
  await writePrivateFiles(sandbox, [
    { path: OPENAI_TOKEN_FILE, content: token },
    { path: "$HOME/.codex/config.toml", content: config },
    { path: SANDBOX_MARKER, content: SANDBOX_GENERATION },
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
  const labels = (sandbox as { labels?: Record<string, string> }).labels;
  if (labels?.[SANDBOX_GENERATION_LABEL] !== SANDBOX_GENERATION) return false;
  const result = await sandbox.process
    .executeCommand(`test \"$(cat ${SANDBOX_MARKER} 2>/dev/null)\" = \"${SANDBOX_GENERATION}\"`, undefined, undefined, 10)
    .catch(() => null);
  return result?.exitCode === 0;
}

/** OpenCode writes its own dynamic provider config, but shares the generation marker. */
export async function markProviderGatewaySandboxCurrent(sandbox: SandboxHandle): Promise<void> {
  if (!providerGatewayWired()) return;
  await writePrivateFiles(sandbox, [
    { path: SANDBOX_MARKER, content: SANDBOX_GENERATION },
  ]);
}
