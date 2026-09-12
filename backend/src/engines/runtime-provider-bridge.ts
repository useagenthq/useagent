import type { EngineId } from "../db/schema";
import type { SandboxHandle } from "../sandboxes/provider";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CLAUDE_CAPABILITY_GID,
  CLAUDE_CONFIG_DIR,
  CLAUDE_MCP_CONFIG_FILE,
  CLAUDE_SETTINGS_FILE,
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
import {
  RUNTIME_ENVIRONMENT_HOME,
  RUNTIME_ENVIRONMENT_WORKDIR,
  runtimeEnvironmentEnabled,
} from "./runtime-environment";
import {
  prepareCodexSubscription,
  type CodexSubscriptionLease,
} from "./codex-subscription-runtime";

const RUNTIME_SETTINGS_PATH = `${RUNTIME_ENVIRONMENT_HOME}/userdata/settings.json`;
const RUNTIME_BIN_DIRECTORY = `${RUNTIME_ENVIRONMENT_HOME}/skynet-bin`;
const RUNTIME_CLAUDE_WRAPPER = `${RUNTIME_BIN_DIRECTORY}/claude`;
const RUNTIME_CLAUDE_ACCESS_HELPER = `${RUNTIME_BIN_DIRECTORY}/prepare-claude-access`;
const RUNTIME_CLAUDE_WRAPPER_PLACEHOLDER = "__USEAGENT_T3_CLAUDE_WRAPPER__";
const CLAUDE_STATUS_CACHE_PATH = `${RUNTIME_ENVIRONMENT_HOME}/caches/claudeAgent.json`;
const CLAUDE_READY_POLL_MS = 150;
const CLAUDE_RUNTIME_UID = 1000;
const CLAUDE_RUNTIME_GID = CLAUDE_CAPABILITY_GID;
const CLAUDE_RUNTIME_HOME = "/home/user";
const CLAUDE_ATTACHMENTS_DIR = "/root/.skynet/t3/userdata/attachments";

interface BootstrapState {
  readonly command: string;
  readonly operation: Promise<void>;
}

// The bootstrap below installs only stable driver paths/settings. Run-bound
// gateway capabilities are refreshed separately on every turn. Remember the
// completed stable bootstrap per live sandbox so a warm claim does not pay an
// extra shell round trip before every first token.
const bootstrapStates = new Map<string | object, BootstrapState>();

type RuntimeEngineId = Extract<EngineId, "codex" | "claude" | "opencode">;

export interface RuntimeProviderBridgeLease extends CodexSubscriptionLease {
  readonly authPath: CodexBridgeAuthPath | null;
  readonly readiness: RuntimeProviderReadiness | null;
}

export interface RuntimeProviderReadiness {
  readonly instanceId: "claudeAgent";
  readonly driver: "claudeAgent";
  readonly displayName: string;
}

const NOOP_PROVIDER_BRIDGE_LEASE: RuntimeProviderBridgeLease = {
  authPath: null,
  authEpoch: null,
  readiness: null,
  async close() {},
};

const CODEX_GATEWAY_BRIDGE_LEASE: RuntimeProviderBridgeLease = {
  authPath: "provider_gateway",
  authEpoch: null,
  readiness: null,
  async close() {},
};

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function assertSafeUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("the provider runtime provider gateway URL must use HTTP(S)");
  }
}

export function claudeProviderReadiness(
  claudeEnvironment: Readonly<Record<string, string>>,
): RuntimeProviderReadiness {
  const anthropicBaseUrl = claudeEnvironment.ANTHROPIC_BASE_URL ?? "";
  const claudeConfigDir = claudeEnvironment.CLAUDE_CONFIG_DIR ?? "";
  const fingerprint = createHash("sha256")
    .update(`${anthropicBaseUrl}\0${claudeConfigDir}\0${RUNTIME_CLAUDE_WRAPPER}`)
    .digest("hex")
    .slice(0, 12);
  return {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: `UseAgent Claude gateway ${fingerprint}`,
  };
}

/**
 * Configure the runtime provider drivers without persisting a bearer token in
 * settings. Codex and OpenCode read their private, dynamically refreshed
 * config files. Claude is launched through a stable wrapper that exports the
 * non-secret gateway URL, grants the dedicated runtime uid access only to this
 * tenant's workspace/config, and drops root before Claude Code starts. Its
 * apiKeyHelper reads the run capability file from the isolated config dir.
 */
export function buildRuntimeProviderBootstrapCommand(
  claudeEnvironment: Readonly<Record<string, string>>,
): string {
  const anthropicBaseUrl = claudeEnvironment.ANTHROPIC_BASE_URL;
  const claudeConfigDir = claudeEnvironment.CLAUDE_CONFIG_DIR;
  if (!anthropicBaseUrl || !claudeConfigDir) {
    throw new Error("the provider runtime Claude provider gateway configuration is incomplete");
  }
  assertSafeUrl(anthropicBaseUrl);
  const readiness = claudeProviderReadiness(claudeEnvironment);

  const accessHelper = [
    "#!/bin/sh",
    "set -eu",
    `CLAUDE_UID=${CLAUDE_RUNTIME_UID}`,
    `CLAUDE_GID=${CLAUDE_RUNTIME_GID}`,
    `CLAUDE_ATTACHMENTS=${JSON.stringify(CLAUDE_ATTACHMENTS_DIR)}`,
    'CLAUDE_WORKDIR="${1:?Claude workspace is required}"',
    'command -v setfacl >/dev/null',
    'test "$(id -u user)" = "$CLAUDE_UID"',
    'test -d "$CLAUDE_WORKDIR"',
    'setfacl -m "u:$CLAUDE_UID:x" /root',
    'chown root:root "$CLAUDE_WORKDIR"',
    'chmod 1777 "$CLAUDE_WORKDIR"',
    'if [ -d "$CLAUDE_ATTACHMENTS" ]; then',
    '  setfacl -m "u:$CLAUDE_UID:x" /root/.skynet /root/.skynet/t3 /root/.skynet/t3/userdata',
    '  setfacl -Rm "u:$CLAUDE_UID:rwx" "$CLAUDE_ATTACHMENTS"',
    '  setfacl -Rdm "u:$CLAUDE_UID:rwx" "$CLAUDE_ATTACHMENTS"',
    "fi",
    "",
  ].join("\n");
  const wrapper = [
    "#!/bin/sh",
    "set -eu",
    `CLAUDE_UID=${CLAUDE_RUNTIME_UID}`,
    `CLAUDE_GID=${CLAUDE_RUNTIME_GID}`,
    `CLAUDE_HOME=${JSON.stringify(CLAUDE_RUNTIME_HOME)}`,
    `ANTHROPIC_BASE_URL=${JSON.stringify(anthropicBaseUrl)}`,
    `CLAUDE_CONFIG_DIR=${JSON.stringify(claudeConfigDir)}`,
    'command -v setpriv >/dev/null',
    'test "$(id -u user)" = "$CLAUDE_UID"',
    'export HOME="$CLAUDE_HOME" USER=user LOGNAME=user',
    "export ANTHROPIC_BASE_URL CLAUDE_CONFIG_DIR",
    `exec setpriv --reuid="$CLAUDE_UID" --regid="$CLAUDE_GID" --clear-groups --no-new-privs -- claude "$@" --settings ${JSON.stringify(CLAUDE_SETTINGS_FILE)} --mcp-config ${JSON.stringify(CLAUDE_MCP_CONFIG_FILE)}`,
    "",
  ].join("\n");
  const claudeProviderConfig = {
    enabled: true,
    binaryPath: RUNTIME_CLAUDE_WRAPPER_PLACEHOLDER,
    homePath: claudeConfigDir,
    customModels: [],
    launchArgs: "",
  };
  const settingsPatch = {
    enableAgentBrowserAccess: false,
    providers: {
      codex: {
        enabled: true,
        binaryPath: "codex",
        homePath: "~/.codex",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      },
      claudeAgent: claudeProviderConfig,
      opencode: {
        enabled: true,
        binaryPath: "opencode",
        serverUrl: "",
        serverPassword: "",
        customModels: [],
      },
    },
    providerInstances: {
      claudeAgent: {
        driver: "claudeAgent",
        displayName: readiness.displayName,
        enabled: true,
        config: claudeProviderConfig,
      },
    },
  };

  return [
    "set -eu",
    `BIN_DIR="${RUNTIME_BIN_DIRECTORY}"`,
    `SETTINGS="${RUNTIME_SETTINGS_PATH}"`,
    `CLAUDE_WRAPPER="${RUNTIME_CLAUDE_WRAPPER}"`,
    `CLAUDE_ACCESS_HELPER="${RUNTIME_CLAUDE_ACCESS_HELPER}"`,
    `CLAUDE_CONFIG_DIR=${JSON.stringify(claudeConfigDir)}`,
    'install -d -m 700 "$BIN_DIR" "$(dirname "$SETTINGS")"',
    'if [ -L "$CLAUDE_CONFIG_DIR" ]; then rm -f -- "$CLAUDE_CONFIG_DIR"; fi',
    `install -d -o ${CLAUDE_RUNTIME_UID} -g ${CLAUDE_RUNTIME_GID} -m 700 "$CLAUDE_CONFIG_DIR"`,
    `printf %s '${encode(wrapper)}' | base64 -d > "$CLAUDE_WRAPPER"`,
    `printf %s '${encode(accessHelper)}' | base64 -d > "$CLAUDE_ACCESS_HELPER"`,
    'chmod 700 "$CLAUDE_WRAPPER" "$CLAUDE_ACCESS_HELPER"',
    `"$CLAUDE_ACCESS_HELPER" ${JSON.stringify(RUNTIME_ENVIRONMENT_WORKDIR)}`,
    `export PATCH_B64='${encode(JSON.stringify(settingsPatch))}'`,
    `node -e 'const fs=require("node:fs");const path=process.argv[1];const wrapper=process.argv[2];const patch=JSON.parse(Buffer.from(process.env.PATCH_B64,"base64").toString("utf8"));patch.providers.claudeAgent.binaryPath=wrapper;patch.providerInstances.claudeAgent.config.binaryPath=wrapper;let current={};try{current=JSON.parse(fs.readFileSync(path,"utf8"))}catch{};current.enableAgentBrowserAccess=patch.enableAgentBrowserAccess;current.providers={...(current.providers??{}),...patch.providers};current.providerInstances={...(current.providerInstances??{}),...patch.providerInstances};const tmp=path+".tmp";fs.writeFileSync(tmp,JSON.stringify(current));fs.chmodSync(tmp,0o600);fs.renameSync(tmp,path)' "$SETTINGS" "$CLAUDE_WRAPPER"`,
  ].join("\n");
}

/** Probe the status cache rather than settings.json: the settings file only
 * proves that Pro wrote the gateway instance, while this marker proves T3
 * reconciled and published that exact instance. This is intentionally not a
 * provider-health gate: Claude's valid capability probe can take up to 29s,
 * and session startup owns that health/error path. */
export function buildRuntimeProviderReadyProbeCommand(
  readiness: RuntimeProviderReadiness,
): string {
  const script = [
    'const fs=require("node:fs")',
    "let v",
    'try{v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}',
    `process.exit(v&&v.instanceId===${JSON.stringify(readiness.instanceId)}&&v.driver===${JSON.stringify(readiness.driver)}&&v.displayName===${JSON.stringify(readiness.displayName)}&&v.enabled===true&&v.availability!=="unavailable"?0:1)`,
  ].join(";");
  return [
    "set -eu",
    `node -e ${JSON.stringify(script)} ${JSON.stringify(CLAUDE_STATUS_CACHE_PATH)}`,
  ].join("\n");
}

async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function awaitRuntimeProviderReady(
  sandbox: Pick<SandboxHandle, "process">,
  signal: AbortSignal,
  deadlineMs: number,
  readiness: RuntimeProviderReadiness,
): Promise<boolean> {
  const command = buildRuntimeProviderReadyProbeCommand(readiness);
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadlineMs));
  const probeSignal = AbortSignal.any([signal, deadlineSignal]);
  while (true) {
    signal.throwIfAborted();
    if (deadlineSignal.aborted) return false;
    let probe;
    try {
      probe = await awaitWithAbort(
        sandbox.process.executeCommand(command, undefined, undefined, 5).catch(() => null),
        probeSignal,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (deadlineSignal.aborted) return false;
      throw error;
    }
    signal.throwIfAborted();
    if (deadlineSignal.aborted) return false;
    if ((probe?.exitCode ?? 1) === 0) return true;
    try {
      await delay(CLAUDE_READY_POLL_MS, undefined, { signal: probeSignal });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (deadlineSignal.aborted) return false;
      throw error;
    }
  }
}

async function ensureRuntimeProviderBootstrap(
  sandbox: SandboxHandle,
  command: string,
): Promise<void> {
  const key: string | object = sandbox.id || sandbox;
  const current = bootstrapStates.get(key);
  if (current?.command === command) return await current.operation;

  const operation = (async () => {
    const result = await sandbox.process.executeCommand(command, undefined, undefined, 20);
    if ((result.exitCode ?? 1) !== 0) {
      throw new Error("the provider runtime provider bridge bootstrap failed");
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

async function prepareClaudeRuntimeAccess(
  sandbox: Pick<SandboxHandle, "process">,
  workdir: string,
): Promise<void> {
  const result = await sandbox.process.executeCommand(
    `${RUNTIME_CLAUDE_ACCESS_HELPER} ${JSON.stringify(workdir)}`,
    undefined,
    undefined,
    30,
  );
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("the provider runtime Claude non-root boundary failed");
  }
}

async function prepareOpenCodeGateway(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
): Promise<void> {
  const baseConfig = await readOpencodeSandboxConfig(sandbox);
  const prepared = await prepareOpencodeSandboxConfig(sandbox, ctx, baseConfig);
  if (!prepared?.state.provider) {
    throw new Error("the provider runtime OpenCode provider gateway configuration failed");
  }
  await writeOpencodeSandboxConfig(sandbox, prepared.config);
  await markProviderGatewaySandboxCurrent(sandbox);
}

/**
 * Backend-only selector for subscription-backed Codex runtime auth. The returned
 * managed app-server home is never copied into the sandbox; callers must use it
 * only from trusted backend app-server/CLI integration.
 */
export async function resolveCodexSubscriptionRuntime(
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

export async function prepareRuntimeProviderBridge(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
  engine: RuntimeEngineId,
  workdir: string,
): Promise<RuntimeProviderBridgeLease> {
  const claudeEnvironment = providerGatewayEnv(ctx, "claude");
  const command = buildRuntimeProviderBootstrapCommand(claudeEnvironment);

  if (engine === "opencode") {
    await prepareOpenCodeGateway(sandbox, ctx);
  } else if (engine === "claude") {
    await prepareProviderGatewaySandbox(sandbox, ctx, engine, {
      rootOwnedClaudeCapability: true,
    });
  } else {
    const mode = engineAuthMode("codex");
    if (!mode) throw new Error("invalid ENGINE_AUTH_MODE_CODEX");
    const subscription = mode === "provider_gateway"
      ? null
      : await resolveCodexSubscriptionRuntime(ctx);
    const authPath = codexBridgeAuthPath(subscription !== null);
    if (authPath === "subscription") {
      if (!subscription) throw new Error("codex_subscription_runtime_missing");
      await ensureRuntimeProviderBootstrap(sandbox, command);
      const lease = await prepareCodexSubscription({ sandbox, ctx, workdir, runtime: subscription });
      return {
        authPath: "subscription",
        authEpoch: lease.authEpoch,
        readiness: null,
        close: () => lease.close(),
      };
    }
    await prepareProviderGatewaySandbox(sandbox, ctx, engine);
  }

  await ensureRuntimeProviderBootstrap(sandbox, command);
  if (engine === "claude") {
    await prepareClaudeRuntimeAccess(sandbox, workdir);
    return {
      authPath: null,
      authEpoch: null,
      readiness: claudeProviderReadiness(claudeEnvironment),
      async close() {},
    };
  }
  return engine === "codex" ? CODEX_GATEWAY_BRIDGE_LEASE : NOOP_PROVIDER_BRIDGE_LEASE;
}

/** Install stable provider driver paths before a warm runtime server starts. No
 * run capability is minted here; per-run preparation supplies those later. */
export async function prewarmRuntimeProviderBridge(
  sandbox: SandboxHandle,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  if (!runtimeEnvironmentEnabled(env)) return;
  const command = buildRuntimeProviderBootstrapCommand(claudeProviderGatewayEnvironment());
  await ensureRuntimeProviderBootstrap(sandbox, command);
}

export function resetRuntimeProviderBridgeCacheForTest(): void {
  bootstrapStates.clear();
}
