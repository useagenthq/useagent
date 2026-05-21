import type { EngineId } from "../db/schema";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  claudeProviderGatewayEnvironment,
  markProviderGatewaySandboxCurrent,
  prepareProviderGatewaySandbox,
  providerGatewayEnv,
} from "../provider-gateway/sandbox-config";
import {
  getCodexSubscriptionRuntimeSelection,
  type CodexSubscriptionRuntimeSelection,
} from "../provider-connections/service";
import { engineAuthMode } from "../runs/engine-auth-mode";
import type { EngineRunContext } from "./types";
import {
  prepareOpencodeSandboxConfig,
  readOpencodeSandboxConfig,
  writeOpencodeSandboxConfig,
} from "./opencode-server";
import { T3_ENVIRONMENT_HOME } from "./t3-environment";
import { t3EnvironmentEnabled } from "./t3-environment";
import {
  prepareT3CodexSubscription,
  type T3CodexSubscriptionLease,
} from "./t3-codex-subscription";

const T3_SETTINGS_PATH = `${T3_ENVIRONMENT_HOME}/userdata/settings.json`;
const T3_BIN_DIRECTORY = `${T3_ENVIRONMENT_HOME}/skynet-bin`;
const T3_CLAUDE_WRAPPER = `${T3_BIN_DIRECTORY}/claude`;
const T3_CLAUDE_WRAPPER_PLACEHOLDER = "__SKYNET_T3_CLAUDE_WRAPPER__";

interface BootstrapState {
  readonly command: string;
  readonly operation: Promise<void>;
}

// The bootstrap below installs only stable driver paths/settings. Run-bound
// gateway capabilities are refreshed separately on every turn. Remember the
// completed stable bootstrap per live sandbox so a warm claim does not pay an
// extra shell round trip before every first token.
const bootstrapStates = new Map<string | object, BootstrapState>();

type T3EngineId = Extract<EngineId, "codex" | "claude" | "opencode">;

export type T3ProviderBridgeLease = T3CodexSubscriptionLease;

const NOOP_PROVIDER_BRIDGE_LEASE: T3ProviderBridgeLease = {
  async close() {},
};

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function assertSafeUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("T3 provider gateway URL must use HTTP(S)");
  }
}

/**
 * Configure T3's provider drivers without persisting a bearer token in T3
 * settings. Codex and OpenCode read their private, dynamically refreshed
 * config files. Claude is launched through a stable wrapper that exports only
 * the non-secret gateway URL; its apiKeyHelper reads the run capability file.
 */
export function buildT3ProviderBootstrapCommand(
  claudeEnvironment: Readonly<Record<string, string>>,
): string {
  const anthropicBaseUrl = claudeEnvironment.ANTHROPIC_BASE_URL;
  const claudeConfigDir = claudeEnvironment.CLAUDE_CONFIG_DIR;
  if (!anthropicBaseUrl || !claudeConfigDir) {
    throw new Error("T3 Claude provider gateway configuration is incomplete");
  }
  assertSafeUrl(anthropicBaseUrl);

  const wrapper = [
    "#!/bin/sh",
    "set -eu",
    `export ANTHROPIC_BASE_URL=${JSON.stringify(anthropicBaseUrl)}`,
    `export CLAUDE_CONFIG_DIR=${JSON.stringify(claudeConfigDir)}`,
    'exec claude --mcp-config "$CLAUDE_CONFIG_DIR/skynet-mcp.json" "$@"',
    "",
  ].join("\n");
  const settingsPatch = {
    providers: {
      codex: {
        enabled: true,
        binaryPath: "codex",
        homePath: "~/.codex",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      },
      claudeAgent: {
        enabled: true,
        binaryPath: T3_CLAUDE_WRAPPER_PLACEHOLDER,
        homePath: claudeConfigDir,
        customModels: [],
        launchArgs: "",
      },
      opencode: {
        enabled: true,
        binaryPath: "opencode",
        serverUrl: "",
        serverPassword: "",
        customModels: [],
      },
    },
  };

  return [
    "set -eu",
    `BIN_DIR="${T3_BIN_DIRECTORY}"`,
    `SETTINGS="${T3_SETTINGS_PATH}"`,
    `CLAUDE_WRAPPER="${T3_CLAUDE_WRAPPER}"`,
    'install -d -m 700 "$BIN_DIR" "$(dirname "$SETTINGS")"',
    `printf %s '${encode(wrapper)}' | base64 -d > "$CLAUDE_WRAPPER"`,
    'chmod 700 "$CLAUDE_WRAPPER"',
    `export PATCH_B64='${encode(JSON.stringify(settingsPatch))}'`,
    `node -e 'const fs=require("node:fs");const path=process.argv[1];const wrapper=process.argv[2];const patch=JSON.parse(Buffer.from(process.env.PATCH_B64,"base64").toString("utf8"));patch.providers.claudeAgent.binaryPath=wrapper;let current={};try{current=JSON.parse(fs.readFileSync(path,"utf8"))}catch{};current.providers={...(current.providers??{}),...patch.providers};const tmp=path+".tmp";fs.writeFileSync(tmp,JSON.stringify(current));fs.chmodSync(tmp,0o600);fs.renameSync(tmp,path)' "$SETTINGS" "$CLAUDE_WRAPPER"`,
  ].join("\n");
}

async function ensureT3ProviderBootstrap(
  sandbox: SandboxHandle,
  command: string,
): Promise<void> {
  const key: string | object = sandbox.id || sandbox;
  const current = bootstrapStates.get(key);
  if (current?.command === command) return await current.operation;

  const operation = (async () => {
    const result = await sandbox.process.executeCommand(command, undefined, undefined, 20);
    if ((result.exitCode ?? 1) !== 0) {
      throw new Error("T3 provider bridge bootstrap failed");
    }
  })();
  const state = { command, operation } satisfies BootstrapState;
  bootstrapStates.set(key, state);
  try {
    await operation;
  } catch (error) {
    if (bootstrapStates.get(key) === state) bootstrapStates.delete(key);
    throw error;
  }
}

async function prepareOpenCodeGateway(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
): Promise<void> {
  const baseConfig = await readOpencodeSandboxConfig(sandbox);
  const prepared = await prepareOpencodeSandboxConfig(sandbox, ctx, baseConfig);
  if (!prepared?.state.provider) {
    throw new Error("T3 OpenCode provider gateway configuration failed");
  }
  await writeOpencodeSandboxConfig(sandbox, prepared.config);
  await markProviderGatewaySandboxCurrent(sandbox);
}

/**
 * Backend-only selector for subscription-backed Codex runtime auth. The returned
 * managed app-server home is never copied into the sandbox; callers must use it
 * only from trusted backend app-server/CLI integration.
 */
export async function resolveT3CodexSubscriptionRuntime(
  ctx: Pick<EngineRunContext, "orgId" | "userId">,
): Promise<CodexSubscriptionRuntimeSelection | null> {
  if (!ctx.orgId || !ctx.userId) return null;
  return getCodexSubscriptionRuntimeSelection({
    orgId: ctx.orgId,
    userId: ctx.userId,
    provider: "openai",
  });
}

export type CodexBridgeAuthPath = "subscription" | "provider_gateway";

/** Decide the one credential boundary used for a Codex turn. Subscription-only
 * mode never falls back to an API key, while hybrid preserves the historical
 * prefer-account-then-gateway behavior. */
export function codexBridgeAuthPath(
  subscriptionAvailable: boolean,
  env: Record<string, string | undefined> = process.env,
): CodexBridgeAuthPath {
  const mode = engineAuthMode("codex", env);
  if (!mode) throw new Error("invalid ENGINE_AUTH_MODE_CODEX");
  if (mode === "provider_gateway") return "provider_gateway";
  if (subscriptionAvailable) return "subscription";
  if (mode === "subscription") throw new Error("codex_subscription_required");
  return "provider_gateway";
}

export async function prepareT3ProviderBridge(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
  engine: T3EngineId,
  workdir: string,
): Promise<T3ProviderBridgeLease> {
  const claudeEnvironment = providerGatewayEnv(ctx, "claude");
  const command = buildT3ProviderBootstrapCommand(claudeEnvironment);

  if (engine === "opencode") {
    await prepareOpenCodeGateway(sandbox, ctx);
  } else if (engine === "claude") {
    await prepareProviderGatewaySandbox(sandbox, ctx, engine);
  } else {
    const mode = engineAuthMode("codex");
    if (!mode) throw new Error("invalid ENGINE_AUTH_MODE_CODEX");
    const subscription = mode === "provider_gateway"
      ? null
      : await resolveT3CodexSubscriptionRuntime(ctx);
    const authPath = codexBridgeAuthPath(subscription !== null);
    if (authPath === "subscription") {
      if (!subscription) throw new Error("codex_subscription_runtime_missing");
      await ensureT3ProviderBootstrap(sandbox, command);
      return prepareT3CodexSubscription({ sandbox, ctx, workdir, runtime: subscription });
    }
    await prepareProviderGatewaySandbox(sandbox, ctx, engine);
  }

  await ensureT3ProviderBootstrap(sandbox, command);
  return NOOP_PROVIDER_BRIDGE_LEASE;
}

/** Install stable provider driver paths before a warm T3 server starts. No
 * run capability is minted here; per-run preparation supplies those later. */
export async function prewarmT3ProviderBridge(
  sandbox: SandboxHandle,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  if (!t3EnvironmentEnabled(env)) return;
  const command = buildT3ProviderBootstrapCommand(claudeProviderGatewayEnvironment());
  await ensureT3ProviderBootstrap(sandbox, command);
}

export function resetT3ProviderBridgeCacheForTest(): void {
  bootstrapStates.clear();
}
