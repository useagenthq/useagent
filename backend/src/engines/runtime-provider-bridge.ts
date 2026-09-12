import type { EngineId } from "../db/schema";
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { sandboxPlugin } from "../sandboxes/plugins";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CLAUDE_CAPABILITY_GID,
  CLAUDE_CONFIG_DIR,
  CLAUDE_MCP_CONFIG_FILE,
  CLAUDE_SETTINGS_FILE,
  claudeProviderGatewayEnvironment,
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
  RUNTIME_ENVIRONMENT_HOME,
  RUNTIME_ENVIRONMENT_WORKDIR,
  runtimeEnvironmentEnabled,
} from "./runtime-environment";
import {
  prepareCodexSubscription,
  type CodexSubscriptionLease,
} from "./codex-subscription-runtime";
import {
  buildSandboxBunProbeCommand,
  ensureSandboxBun,
  sandboxBunExecutable,
} from "./sandbox-bun";
import { prepareOpenCodeGateway } from "./opencode-model-limit-refresh";
import {
  buildAttachmentTreeAccessCommand,
  buildRootTraversalAccessCommand,
} from "./runtime-user-permissions";
export { openCodeModelLimitsChanged } from "./opencode-model-limit-refresh";

const RUNTIME_SETTINGS_PATH = `${RUNTIME_ENVIRONMENT_HOME}/userdata/settings.json`;
const RUNTIME_BIN_DIRECTORY = `${RUNTIME_ENVIRONMENT_HOME}/skynet-bin`;
const RUNTIME_CLAUDE_WRAPPER = `${RUNTIME_BIN_DIRECTORY}/claude`;
const RUNTIME_CLAUDE_ACCESS_HELPER = `${RUNTIME_BIN_DIRECTORY}/prepare-claude-access`;
const RUNTIME_CLAUDE_WRAPPER_PLACEHOLDER = "__USEAGENT_T3_CLAUDE_WRAPPER__";
const CLAUDE_STATUS_CACHE_PATH = `${RUNTIME_ENVIRONMENT_HOME}/caches/claudeAgent.json`;
const CLAUDE_BOOTSTRAP_MARKER_PATH = `${RUNTIME_ENVIRONMENT_HOME}/caches/useagent-claude-bootstrap`;
const CLAUDE_READY_POLL_MS = 150;
const NATIVE_VERSION_PROBE_ATTEMPTS = 3;
const NATIVE_VERSION_PROBE_DELAYS_MS = [250, 500] as const;
const NATIVE_VERSION_PROBE_DIAGNOSTIC_PREFIX = "useagent-native-version-probe:";
const CODEX_VERSION = "0.153.3";
const CLAUDE_CODE_VERSION = "2.1.226";
const OPENCODE_VERSION = "1.18.7";
/** The pinned driver versions the bootstrap installs; the native image name is derived from them. */
export const RUNTIME_ENGINE_VERSIONS = {
  codex: CODEX_VERSION,
  claude: CLAUDE_CODE_VERSION,
  opencode: OPENCODE_VERSION,
} as const;
const CLAUDE_RUNTIME_UID = 1000;
const CLAUDE_RUNTIME_GID = CLAUDE_CAPABILITY_GID;
const CLAUDE_RUNTIME_HOME = "/home/user";
const ROOT_RUNTIME_LAYOUT: SandboxRuntimeLayout = {
  home: "/root",
  workdir: RUNTIME_ENVIRONMENT_WORKDIR,
  runsAsRoot: true,
};

const CODEX_INSTALL_IDENTITY_SCRIPT = [
  'const fs=require("node:fs"),path=require("node:path")',
  'const binary=process.argv[1],packageDirectory=process.argv[2],expectedVersion=process.argv[3],diagnostic=process.argv[4]==="diagnostic"',
  'try{const packageRoot=fs.realpathSync(packageDirectory);const manifest=JSON.parse(fs.readFileSync(path.join(packageRoot,"package.json"),"utf8"));const binEntry=typeof manifest.bin==="string"?manifest.bin:manifest.bin?.codex;const binaryReal=fs.realpathSync(binary);const entryReal=fs.realpathSync(path.join(packageRoot,"bin/codex.js"));const target=process.arch==="x64"?{alias:"@openai/codex-linux-x64",suffix:"linux-x64",triple:"x86_64-unknown-linux-musl"}:process.arch==="arm64"?{alias:"@openai/codex-linux-arm64",suffix:"linux-arm64",triple:"aarch64-unknown-linux-musl"}:null;if(!target)throw new Error("unsupported_arch");const nodeModulesRoot=path.resolve(packageRoot,"../..");const platformRoot=fs.realpathSync(path.join(nodeModulesRoot,target.alias));const platformManifest=JSON.parse(fs.readFileSync(path.join(platformRoot,"package.json"),"utf8"));const nativeReal=fs.realpathSync(path.join(platformRoot,"vendor",target.triple,"bin/codex"));const nativeRelative=path.relative(platformRoot,nativeReal);fs.accessSync(binary,fs.constants.X_OK);fs.accessSync(nativeReal,fs.constants.X_OK);if(manifest.name!=="@openai/codex"||manifest.version!==expectedVersion||binEntry!=="bin/codex.js"||binaryReal!==entryReal||!fs.statSync(entryReal).isFile()||platformManifest.name!=="@openai/codex"||platformManifest.version!==expectedVersion+"-"+target.suffix||nativeRelative===""||nativeRelative.startsWith(".."+path.sep)||path.isAbsolute(nativeRelative)||!fs.statSync(nativeReal).isFile())throw new Error("identity_mismatch");process.exit(0)}catch{if(diagnostic)console.error("useagent-native-version-probe: install_identity_mismatch expected="+expectedVersion);process.exit(1)}',
].join(";");

const CLAUDE_INSTALL_IDENTITY_SCRIPT = [
  'const fs=require("node:fs"),path=require("node:path")',
  'const binary=process.argv[1],packageDirectory=process.argv[2],expectedVersion=process.argv[3],diagnostic=process.argv[4]==="diagnostic"',
  'try{const packageRoot=fs.realpathSync(packageDirectory);const manifest=JSON.parse(fs.readFileSync(path.join(packageRoot,"package.json"),"utf8"));const binEntry=typeof manifest.bin==="string"?manifest.bin:manifest.bin?.claude;const binaryReal=fs.realpathSync(binary);const nodeModulesRoot=path.resolve(packageRoot,"../..");const isPlatformPackage=name=>name.startsWith("@anthropic-ai/claude-code-darwin-")||name.startsWith("@anthropic-ai/claude-code-linux-")||name.startsWith("@anthropic-ai/claude-code-win32-");const allowedRoots=[packageRoot,...Object.entries(manifest.optionalDependencies??{}).filter(([name,version])=>isPlatformPackage(name)&&version===expectedVersion).flatMap(([name])=>{try{const root=fs.realpathSync(path.join(nodeModulesRoot,name));const dependency=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));return dependency.name===name&&dependency.version===expectedVersion?[root]:[]}catch{return []}})];const contained=allowedRoots.some(root=>{const relative=path.relative(root,binaryReal);return relative!==""&&!relative.startsWith(".."+path.sep)&&!path.isAbsolute(relative)});fs.accessSync(binary,fs.constants.X_OK);if(manifest.name!=="@anthropic-ai/claude-code"||manifest.version!==expectedVersion||binEntry!=="bin/claude.exe"||!contained)throw new Error("identity_mismatch");process.exit(0)}catch{if(diagnostic)console.error("useagent-native-version-probe: install_identity_mismatch expected="+expectedVersion);process.exit(1)}',
].join(";");

const OPENCODE_INSTALL_IDENTITY_SCRIPT = [
  'const fs=require("node:fs"),path=require("node:path")',
  'const binary=process.argv[1],packageDirectory=process.argv[2],expectedVersion=process.argv[3],diagnostic=process.argv[4]==="diagnostic"',
  'try{const packageRoot=fs.realpathSync(packageDirectory);const manifest=JSON.parse(fs.readFileSync(path.join(packageRoot,"package.json"),"utf8"));const binEntry=typeof manifest.bin==="string"?manifest.bin:manifest.bin?.opencode;const binaryReal=fs.realpathSync(binary);const relative=path.relative(packageRoot,binaryReal);const contained=relative!==""&&!relative.startsWith(".."+path.sep)&&!path.isAbsolute(relative);fs.accessSync(binary,fs.constants.X_OK);if(manifest.name!=="opencode-ai"||manifest.version!==expectedVersion||binEntry!=="./bin/opencode.exe"||!contained||binaryReal!==fs.realpathSync(path.resolve(packageRoot,binEntry))||!fs.statSync(binaryReal).isFile())throw new Error("identity_mismatch");const fd=fs.openSync(binaryReal,"r"),magic=Buffer.alloc(4);try{if(fs.readSync(fd,magic,0,4,0)!==4||!magic.equals(Buffer.from([127,69,76,70])))throw new Error("not_native_elf")}finally{fs.closeSync(fd)}process.exit(0)}catch{if(diagnostic)console.error("useagent-native-version-probe: install_identity_mismatch expected="+expectedVersion);process.exit(1)}',
].join(";");

export function buildClaudeInstallIdentityProbeCommand(
  layout: SandboxRuntimeLayout = ROOT_RUNTIME_LAYOUT,
  diagnostic = false,
): string {
  const prefix = layout.runsAsRoot ? "/usr/local" : `${layout.home}/.local`;
  return `node -e ${JSON.stringify(CLAUDE_INSTALL_IDENTITY_SCRIPT)} ${JSON.stringify(`${prefix}/bin/claude`)} ${JSON.stringify(`${prefix}/share/useagent/native-engines/node_modules/@anthropic-ai/claude-code`)} ${JSON.stringify(CLAUDE_CODE_VERSION)} ${diagnostic ? "diagnostic" : "quiet"}`;
}

export function buildCodexInstallIdentityProbeCommand(
  layout: SandboxRuntimeLayout = ROOT_RUNTIME_LAYOUT,
  diagnostic = false,
): string {
  const prefix = layout.runsAsRoot ? "/usr/local" : `${layout.home}/.local`;
  return `node -e ${JSON.stringify(CODEX_INSTALL_IDENTITY_SCRIPT)} ${JSON.stringify(`${prefix}/bin/codex`)} ${JSON.stringify(`${prefix}/share/useagent/native-engines/node_modules/@openai/codex`)} ${JSON.stringify(CODEX_VERSION)} ${diagnostic ? "diagnostic" : "quiet"}`;
}

export function buildOpenCodeInstallIdentityProbeCommand(
  layout: SandboxRuntimeLayout = ROOT_RUNTIME_LAYOUT,
  diagnostic = false,
): string {
  const prefix = layout.runsAsRoot ? "/usr/local" : `${layout.home}/.local`;
  return `node -e ${JSON.stringify(OPENCODE_INSTALL_IDENTITY_SCRIPT)} ${JSON.stringify(`${prefix}/bin/opencode`)} ${JSON.stringify(`${prefix}/share/useagent/native-engines/node_modules/opencode-ai`)} ${JSON.stringify(OPENCODE_VERSION)} ${diagnostic ? "diagnostic" : "quiet"}`;
}

function runtimeBridgeLayout(sandbox: Pick<SandboxHandle, "providerKind">): SandboxRuntimeLayout {
  if (!sandbox.providerKind) return ROOT_RUNTIME_LAYOUT;
  const plugin = sandboxPlugin(sandbox.providerKind);
  return { ...plugin.runtime, runsAsRoot: plugin.runsAsRoot };
}

// The bootstrap below installs only stable driver paths/settings. Run-bound
// gateway capabilities are refreshed separately on every turn. Remember the
// completed stable bootstrap per live sandbox so warm revalidation can combine
// the Bun and provider identity checks in one shell round trip.
const bootstrapStates = new Map<string | object, Map<string, Promise<void>>>();

type RuntimeEngineId = Extract<EngineId, "codex" | "claude" | "opencode">;

export interface RuntimeProviderBridgeLease extends CodexSubscriptionLease {
  readonly authPath: CodexBridgeAuthPath | null;
  readonly readiness: RuntimeProviderReadiness | null;
  readonly modelLimitsChanged: boolean;
  readonly modelLimitsRevision: string | null;
  readonly modelLimitsChangedAt: string | null;
  readonly ackModelLimitsReload: () => Promise<void>;
}

export interface RuntimeProviderReadiness {
  readonly instanceId: "claudeAgent";
  readonly driver: "claudeAgent";
  readonly displayName: string;
}

const NOOP_PROVIDER_BRIDGE_LEASE: RuntimeProviderBridgeLease = {
  authPath: null,
  authEpoch: null,
  hasCurrentEpochThreadBinding: false,
  readiness: null,
  modelLimitsChanged: false,
  modelLimitsRevision: null,
  modelLimitsChangedAt: null,
  async ackModelLimitsReload() {},
  async close() {},
};

const CODEX_GATEWAY_BRIDGE_LEASE: RuntimeProviderBridgeLease = {
  authPath: "provider_gateway",
  authEpoch: null,
  hasCurrentEpochThreadBinding: false,
  readiness: null,
  modelLimitsChanged: false,
  modelLimitsRevision: null,
  modelLimitsChangedAt: null,
  async ackModelLimitsReload() {},
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
 * Configure one selected native runtime driver without persisting a bearer
 * token in settings. Codex and OpenCode read their private, dynamically
 * refreshed config files. Claude is launched through a stable wrapper that
 * exports the non-secret gateway URL, grants the dedicated runtime uid access
 * only to this tenant's workspace/config, and drops root before Claude Code
 * starts. Its apiKeyHelper reads the run capability file from the isolated
 * config dir.
 */
export function buildRuntimeProviderBootstrapCommand(
  engine: RuntimeEngineId,
  claudeEnvironment: Readonly<Record<string, string>> = {},
  layout: SandboxRuntimeLayout = ROOT_RUNTIME_LAYOUT,
): string {
  const anthropicBaseUrl = claudeEnvironment.ANTHROPIC_BASE_URL;
  const claudeConfigDir = claudeEnvironment.CLAUDE_CONFIG_DIR;
  if (engine === "claude" && (!anthropicBaseUrl || !claudeConfigDir)) {
    throw new Error("the provider runtime Claude provider gateway configuration is incomplete");
  }
  if (anthropicBaseUrl) assertSafeUrl(anthropicBaseUrl);
  const prefix = layout.runsAsRoot ? "/usr/local" : `${layout.home}/.local`;
  const nativePackage = engine === "codex"
    ? `@openai/codex@${CODEX_VERSION}`
    : engine === "claude"
      ? `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`
      : `opencode-ai@${OPENCODE_VERSION}`;
  const nativeBinaryName = engine === "claude" ? "claude" : engine;
  const nativeBinary = `${prefix}/bin/${nativeBinaryName}`;
  const nativeGlobalDirectory = `${prefix}/share/useagent/native-engines`;
  const bunExecutable = sandboxBunExecutable(layout);
  const expectedVersion = engine === "codex"
    ? `codex-cli ${CODEX_VERSION}`
    : engine === "claude"
      ? CLAUDE_CODE_VERSION
      : OPENCODE_VERSION;
  const versionMatcher = engine === "claude" ? "prefix" : "exact";
  const verifyScript = [
    'const {spawnSync}=require("node:child_process")',
    'const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)',
    'const binary=process.argv[1],expected=process.argv[2],matcher=process.argv[3]',
    'const attempts=Number(process.argv[4]),diagnostic=process.argv[5]==="diagnostic"',
    `const delays=${JSON.stringify(NATIVE_VERSION_PROBE_DELAYS_MS)}`,
    'let last',
    'for(let attempt=0;attempt<attempts;attempt++){last=spawnSync(binary,["--version"],{encoding:"utf8",timeout:8000});const out=`${last.stdout??""}${last.stderr??""}`.trim();const ok=matcher==="prefix"?out===expected||out.startsWith(expected+" "):out===expected;if(!last.error&&last.status===0&&ok)process.exit(0);if(!last.error&&last.status===0&&out){if(diagnostic)console.error("useagent-native-version-probe: version_mismatch expected="+expected);process.exit(1)}if(attempt+1<attempts)sleep(delays[attempt]??delays.at(-1))}',
    'if(diagnostic){const status=Number.isInteger(last?.status)?last.status:"none";const code=String(last?.error?.code??"none").replace(/[^A-Za-z0-9._-]/g,"_").slice(0,40);console.error(`useagent-native-version-probe: probe_failed attempts=${attempts} last_status=${status} error=${code}`)}',
    'process.exit(1)',
  ].join(";");

  const providerConfig = engine === "codex"
    ? {
        enabled: true,
        binaryPath: nativeBinary,
        homePath: "~/.codex",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      }
    : engine === "opencode"
      ? {
          enabled: true,
          binaryPath: nativeBinary,
          serverUrl: "",
          serverPassword: "",
          customModels: [],
        }
      : null;

  const installAndVerify = engine === "claude" ? [
    `NATIVE_PREFIX=${JSON.stringify(prefix)}`,
    `NATIVE_BINARY=${JSON.stringify(nativeBinary)}`,
    `NATIVE_GLOBAL_DIR=${JSON.stringify(nativeGlobalDirectory)}`,
    `NATIVE_PACKAGE=${JSON.stringify(nativePackage)}`,
    `BUN_EXECUTABLE=${JSON.stringify(bunExecutable)}`,
    `if ! ${buildClaudeInstallIdentityProbeCommand(layout)}; then`,
    '  test -x "$BUN_EXECUTABLE" || command -v "$BUN_EXECUTABLE" >/dev/null 2>&1',
    `  BUN_CACHE="$(mktemp -d "\${TMPDIR:-/tmp}/useagent-${engine}-bun.XXXXXX")"`,
    '  cleanup_native_bun() { rm -rf -- "$BUN_CACHE"; }',
    "  trap cleanup_native_bun EXIT HUP INT TERM",
    '  BUN_INSTALL_CACHE_DIR="$BUN_CACHE" BUN_INSTALL_GLOBAL_DIR="$NATIVE_GLOBAL_DIR" BUN_INSTALL_BIN="$NATIVE_PREFIX/bin" "$BUN_EXECUTABLE" add --global --exact --no-progress "$NATIVE_PACKAGE"',
    "  cleanup_native_bun",
    "  trap - EXIT HUP INT TERM",
    "fi",
    buildClaudeInstallIdentityProbeCommand(layout, true),
  ] : engine === "opencode" ? [
    `NATIVE_PREFIX=${JSON.stringify(prefix)}`,
    `NATIVE_BINARY=${JSON.stringify(nativeBinary)}`,
    `NATIVE_GLOBAL_DIR=${JSON.stringify(nativeGlobalDirectory)}`,
    `NATIVE_PACKAGE=${JSON.stringify(nativePackage)}`,
    `BUN_EXECUTABLE=${JSON.stringify(bunExecutable)}`,
    `if ! ${buildOpenCodeInstallIdentityProbeCommand(layout)}; then`,
    '  test -x "$BUN_EXECUTABLE" || command -v "$BUN_EXECUTABLE" >/dev/null 2>&1',
    `  BUN_CACHE="$(mktemp -d "\${TMPDIR:-/tmp}/useagent-${engine}-bun.XXXXXX")"`,
    '  cleanup_native_bun() { rm -rf -- "$BUN_CACHE"; }',
    "  trap cleanup_native_bun EXIT HUP INT TERM",
    '  BUN_INSTALL_CACHE_DIR="$BUN_CACHE" BUN_INSTALL_GLOBAL_DIR="$NATIVE_GLOBAL_DIR" BUN_INSTALL_BIN="$NATIVE_PREFIX/bin" "$BUN_EXECUTABLE" add --global --exact --no-progress "$NATIVE_PACKAGE"',
    "  cleanup_native_bun",
    "  trap - EXIT HUP INT TERM",
    "fi",
    buildOpenCodeInstallIdentityProbeCommand(layout, true),
  ] : [
    `NATIVE_PREFIX=${JSON.stringify(prefix)}`,
    `NATIVE_BINARY=${JSON.stringify(nativeBinary)}`,
    `NATIVE_GLOBAL_DIR=${JSON.stringify(nativeGlobalDirectory)}`,
    `NATIVE_PACKAGE=${JSON.stringify(nativePackage)}`,
    `BUN_EXECUTABLE=${JSON.stringify(bunExecutable)}`,
    `EXPECTED_VERSION=${JSON.stringify(expectedVersion)}`,
    `VERSION_MATCHER=${JSON.stringify(versionMatcher)}`,
    `verify_native_binary() { test -x "$NATIVE_BINARY" && node -e '${verifyScript}' "$NATIVE_BINARY" "$EXPECTED_VERSION" "$VERSION_MATCHER" "$1" "$2"; }`,
    `if ! verify_native_binary 1 quiet || ! ${buildCodexInstallIdentityProbeCommand(layout)}; then`,
    '  test -x "$BUN_EXECUTABLE" || command -v "$BUN_EXECUTABLE" >/dev/null 2>&1',
    `  BUN_CACHE="$(mktemp -d "\${TMPDIR:-/tmp}/useagent-${engine}-bun.XXXXXX")"`,
    '  cleanup_native_bun() { rm -rf -- "$BUN_CACHE"; }',
    "  trap cleanup_native_bun EXIT HUP INT TERM",
    '  BUN_INSTALL_CACHE_DIR="$BUN_CACHE" BUN_INSTALL_GLOBAL_DIR="$NATIVE_GLOBAL_DIR" BUN_INSTALL_BIN="$NATIVE_PREFIX/bin" "$BUN_EXECUTABLE" add --global --exact --no-progress "$NATIVE_PACKAGE"',
    "  cleanup_native_bun",
    "  trap - EXIT HUP INT TERM",
    "fi",
    `verify_native_binary ${NATIVE_VERSION_PROBE_ATTEMPTS} diagnostic`,
    buildCodexInstallIdentityProbeCommand(layout, true),
  ];

  if (engine !== "claude") {
    const settingsPatch = { provider: engine, config: providerConfig };
    return [
      "set -eu",
      `export HOME=${JSON.stringify(layout.home)}`,
      ...installAndVerify,
      `SETTINGS="${RUNTIME_SETTINGS_PATH}"`,
      'install -d -m 700 "$(dirname "$SETTINGS")"',
      `export PATCH_B64='${encode(JSON.stringify(settingsPatch))}'`,
      `node -e 'const fs=require("node:fs");const path=process.argv[1];const patch=JSON.parse(Buffer.from(process.env.PATCH_B64,"base64").toString("utf8"));let current={};try{current=JSON.parse(fs.readFileSync(path,"utf8"))}catch{};current.providers={...(current.providers??{}),[patch.provider]:patch.config};const tmp=path+".tmp";fs.writeFileSync(tmp,JSON.stringify(current));fs.chmodSync(tmp,0o600);fs.renameSync(tmp,path)' "$SETTINGS"`,
    ].join("\n");
  }

  const readiness = claudeProviderReadiness(claudeEnvironment);
  const safeAnthropicBaseUrl = anthropicBaseUrl!;
  const safeClaudeConfigDir = claudeConfigDir!;

  const attachmentsDir = `${layout.home}/.skynet/t3/userdata/attachments`;
  const accessHelper = layout.runsAsRoot ? [
    "#!/bin/sh",
    "set -eu",
    `CLAUDE_UID=${CLAUDE_RUNTIME_UID}`,
    `CLAUDE_GID=${CLAUDE_RUNTIME_GID}`,
    'CLAUDE_WORKDIR="${1:?Claude workspace is required}"',
    buildRootTraversalAccessCommand({
      paths: ["/root", "/root/.skynet", "/root/.skynet/t3", "/root/.skynet/t3/userdata"],
      uid: CLAUDE_RUNTIME_UID,
      gid: CLAUDE_RUNTIME_GID,
    }),
    'test -d "$CLAUDE_WORKDIR"',
    'test ! -L "$CLAUDE_WORKDIR"',
    'test "$(realpath -e -- "$CLAUDE_WORKDIR")" = "$CLAUDE_WORKDIR"',
    'chown root:root -- "$CLAUDE_WORKDIR"',
    'chmod 1777 -- "$CLAUDE_WORKDIR"',
    'test "$(stat -c \'%u:%g:%a\' -- "$CLAUDE_WORKDIR")" = "0:0:1777"',
    buildAttachmentTreeAccessCommand({
      root: attachmentsDir,
      uid: CLAUDE_RUNTIME_UID,
      gid: CLAUDE_RUNTIME_GID,
    }),
    "",
  ].join("\n") : [
    "#!/bin/sh",
    "set -eu",
    `test "$(id -u)" != "0"`,
    `test "$HOME" = ${JSON.stringify(layout.home)}`,
    'CLAUDE_WORKDIR="${1:?Claude workspace is required}"',
    'test -d "$CLAUDE_WORKDIR"',
    'test -w "$CLAUDE_WORKDIR"',
    "",
  ].join("\n");
  const wrapper = layout.runsAsRoot ? [
    "#!/bin/sh",
    "set -eu",
    `CLAUDE_UID=${CLAUDE_RUNTIME_UID}`,
    `CLAUDE_GID=${CLAUDE_RUNTIME_GID}`,
    `CLAUDE_HOME=${JSON.stringify(CLAUDE_RUNTIME_HOME)}`,
    `ANTHROPIC_BASE_URL=${JSON.stringify(safeAnthropicBaseUrl)}`,
    `CLAUDE_CONFIG_DIR=${JSON.stringify(safeClaudeConfigDir)}`,
    'command -v setpriv >/dev/null',
    'test "$(id -u user)" = "$CLAUDE_UID"',
    'export HOME="$CLAUDE_HOME" USER=user LOGNAME=user',
    "export ANTHROPIC_BASE_URL CLAUDE_CONFIG_DIR",
    `exec setpriv --reuid="$CLAUDE_UID" --regid="$CLAUDE_GID" --clear-groups --no-new-privs -- ${JSON.stringify(nativeBinary)} "$@" --settings ${JSON.stringify(CLAUDE_SETTINGS_FILE)} --mcp-config ${JSON.stringify(CLAUDE_MCP_CONFIG_FILE)}`,
    "",
  ].join("\n") : [
    "#!/bin/sh",
    "set -eu",
    `export HOME=${JSON.stringify(layout.home)} USER=user LOGNAME=user`,
    `export ANTHROPIC_BASE_URL=${JSON.stringify(safeAnthropicBaseUrl)}`,
    `export CLAUDE_CONFIG_DIR=${JSON.stringify(safeClaudeConfigDir)}`,
    `exec ${JSON.stringify(nativeBinary)} "$@" --settings ${JSON.stringify(CLAUDE_SETTINGS_FILE)} --mcp-config ${JSON.stringify(CLAUDE_MCP_CONFIG_FILE)}`,
    "",
  ].join("\n");
  const claudeProviderConfig = {
    enabled: true,
    binaryPath: RUNTIME_CLAUDE_WRAPPER_PLACEHOLDER,
    homePath: safeClaudeConfigDir,
    customModels: [],
    launchArgs: "",
  };
  const settingsPatch = {
    provider: "claudeAgent",
    config: claudeProviderConfig,
    instance: {
      driver: "claudeAgent",
      displayName: readiness.displayName,
      enabled: true,
      config: claudeProviderConfig,
    },
  };

  return [
    "set -eu",
    `export HOME=${JSON.stringify(layout.home)}`,
    ...installAndVerify,
    `BIN_DIR="${RUNTIME_BIN_DIRECTORY}"`,
    `SETTINGS="${RUNTIME_SETTINGS_PATH}"`,
    `CLAUDE_WRAPPER="${RUNTIME_CLAUDE_WRAPPER}"`,
    `CLAUDE_ACCESS_HELPER="${RUNTIME_CLAUDE_ACCESS_HELPER}"`,
    `CLAUDE_CONFIG_DIR=${JSON.stringify(safeClaudeConfigDir)}`,
    `CLAUDE_BOOTSTRAP_MARKER=${JSON.stringify(CLAUDE_BOOTSTRAP_MARKER_PATH)}`,
    'install -d -m 700 "$BIN_DIR" "$(dirname "$SETTINGS")" "$(dirname "$CLAUDE_BOOTSTRAP_MARKER")"',
    'if [ -L "$CLAUDE_CONFIG_DIR" ]; then rm -f -- "$CLAUDE_CONFIG_DIR"; fi',
    ...(layout.runsAsRoot
      ? [`install -d -o ${CLAUDE_RUNTIME_UID} -g ${CLAUDE_RUNTIME_GID} -m 700 "$CLAUDE_CONFIG_DIR"`]
      : ['install -d -m 700 "$CLAUDE_CONFIG_DIR"']),
    `printf %s '${encode(wrapper)}' | base64 -d > "$CLAUDE_WRAPPER"`,
    `printf %s '${encode(accessHelper)}' | base64 -d > "$CLAUDE_ACCESS_HELPER"`,
    'chmod 700 "$CLAUDE_WRAPPER" "$CLAUDE_ACCESS_HELPER"',
    `"$CLAUDE_ACCESS_HELPER" ${JSON.stringify(layout.workdir)}`,
    `node -e 'require("node:fs").writeFileSync(process.argv[1],String(Date.now()),{mode:0o600})' "$CLAUDE_BOOTSTRAP_MARKER"`,
    `export PATCH_B64='${encode(JSON.stringify(settingsPatch))}'`,
    `node -e 'const fs=require("node:fs");const path=process.argv[1];const wrapper=process.argv[2];const patch=JSON.parse(Buffer.from(process.env.PATCH_B64,"base64").toString("utf8"));patch.config.binaryPath=wrapper;patch.instance.config.binaryPath=wrapper;let current={};try{current=JSON.parse(fs.readFileSync(path,"utf8"))}catch{};current.providers={...(current.providers??{}),[patch.provider]:patch.config};current.providerInstances={...(current.providerInstances??{}),[patch.provider]:patch.instance};const tmp=path+".tmp";fs.writeFileSync(tmp,JSON.stringify(current));fs.chmodSync(tmp,0o600);fs.renameSync(tmp,path)' "$SETTINGS" "$CLAUDE_WRAPPER"`,
  ].join("\n");
}

/** Probe T3's authoritative status cache rather than settings.json. The
 * bootstrap marker is written immediately before the settings patch, so a
 * matching cache entry must come from T3's post-bootstrap CLI + SDK health
 * check rather than boot hydration of an older ready snapshot. */
export function buildRuntimeProviderReadyProbeCommand(
  readiness: RuntimeProviderReadiness,
): string {
  const script = [
    'const fs=require("node:fs")',
    "let v",
    'try{v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}',
    'let marker',
    'try{marker=Number(fs.readFileSync(process.argv[2],"utf8"))}catch{process.exit(1)}',
    `const current=v&&v.instanceId===${JSON.stringify(readiness.instanceId)}&&v.driver===${JSON.stringify(readiness.driver)}&&v.displayName===${JSON.stringify(readiness.displayName)}&&v.enabled===true&&(v.availability===undefined||v.availability==="available")`,
    'const fresh=current&&Number.isFinite(marker)&&Number.isFinite(Date.parse(v.checkedAt))&&Date.parse(v.checkedAt)>marker',
    `process.exit(fresh&&v.installed===true&&v.version===${JSON.stringify(CLAUDE_CODE_VERSION)}&&v.status==="ready"&&v.auth?.status==="authenticated"?0:1)`,
  ].join(";");
  return [
    "set -eu",
    `node -e ${JSON.stringify(script)} ${JSON.stringify(CLAUDE_STATUS_CACHE_PATH)} ${JSON.stringify(CLAUDE_BOOTSTRAP_MARKER_PATH)}`,
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
  engine: RuntimeEngineId,
  command: string,
  layout: SandboxRuntimeLayout,
  signal: AbortSignal,
): Promise<void> {
  const key: string | object = sandbox.id || sandbox;
  let sandboxStates = bootstrapStates.get(key);
  if (!sandboxStates) {
    sandboxStates = new Map();
    bootstrapStates.set(key, sandboxStates);
  }
  const current = sandboxStates.get(command);
  if (current) {
    await current;
    signal.throwIfAborted();
    const validationCommand = [
      "set -eu",
      buildSandboxBunProbeCommand(layout),
      engine === "codex"
        ? buildCodexInstallIdentityProbeCommand(layout)
        : engine === "claude"
          ? buildClaudeInstallIdentityProbeCommand(layout)
          : buildOpenCodeInstallIdentityProbeCommand(layout),
    ].join("\n");
    const validation = await sandbox.process
      .executeCommand(validationCommand, undefined, undefined, 10)
      .catch(() => null);
    signal.throwIfAborted();
    if (validation?.exitCode === 0) return;

    // The sandbox or retained filesystem changed after bootstrap. Evict only
    // this command's completed memo so the full exact Bun repair runs and
    // revalidates the install before native startup (and refreshes Claude's
    // health fence) before any provider dispatch.
    const latest = sandboxStates.get(command);
    if (latest !== current) {
      if (latest) return await latest;
    } else {
      sandboxStates.delete(command);
    }
  }

  const operation = (async () => {
    await ensureSandboxBun(sandbox, layout, signal);
    signal.throwIfAborted();
    const result = await sandbox.process.executeCommand(command, undefined, undefined, 180);
    if ((result.exitCode ?? 1) !== 0) {
      const diagnostic = (result.result ?? "")
        .split(/\r?\n/)
        .find((line) => line.startsWith(NATIVE_VERSION_PROBE_DIAGNOSTIC_PREFIX));
      const safeDiagnostic = diagnostic?.match(
        /^useagent-native-version-probe: (?:install_identity_mismatch expected=[A-Za-z0-9.+_-]{1,80}|version_mismatch expected=[A-Za-z0-9 .+_-]{1,80}|probe_failed attempts=3 last_status=(?:-?\d+|none) error=[A-Za-z0-9._-]{1,40})$/,
      )?.[0];
      throw new Error(
        `the native ${engine} runtime bootstrap failed${safeDiagnostic ? `: ${safeDiagnostic}` : ""}`,
      );
    }
  })();
  sandboxStates.set(command, operation);
  try {
    await operation;
  } catch (error) {
    if (sandboxStates.get(command) === operation) sandboxStates.delete(command);
    if (sandboxStates.size === 0) bootstrapStates.delete(key);
    throw error;
  }
}

async function ensureSelectedRuntimeProviderBootstrap(
  sandbox: SandboxHandle,
  engine: RuntimeEngineId,
  claudeEnvironment: Readonly<Record<string, string>>,
  layout: SandboxRuntimeLayout,
  signal: AbortSignal,
): Promise<void> {
  const command = buildRuntimeProviderBootstrapCommand(
    engine,
    claudeEnvironment,
    layout,
  );
  await ensureRuntimeProviderBootstrap(sandbox, engine, command, layout, signal);
}

/** Install and verify one selected native provider, including its stable T3
 * settings, without creating a run-bound capability, relay, or process lease. */
export async function prepareStableRuntimeProvider(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
  engine: RuntimeEngineId,
): Promise<void> {
  const layout = runtimeBridgeLayout(sandbox);
  const claudeEnvironment = engine === "claude" ? providerGatewayEnv(ctx, "claude") : {};
  await ensureSelectedRuntimeProviderBootstrap(
    sandbox,
    engine,
    claudeEnvironment,
    layout,
    ctx.signal,
  );
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
  stableProviderPrepared = false,
): Promise<RuntimeProviderBridgeLease> {
  const layout = runtimeBridgeLayout(sandbox);
  const claudeEnvironment = engine === "claude" ? providerGatewayEnv(ctx, "claude") : {};
  if (!stableProviderPrepared) {
    await prepareStableRuntimeProvider(sandbox, ctx, engine);
  }

  if (engine === "opencode") {
    const modelLimitRefresh = await prepareOpenCodeGateway(sandbox, ctx);
    return {
      authPath: null,
      authEpoch: null,
      hasCurrentEpochThreadBinding: false,
      readiness: null,
      modelLimitsChanged: modelLimitRefresh.changed,
      modelLimitsRevision: modelLimitRefresh.revision,
      modelLimitsChangedAt: modelLimitRefresh.changedAt,
      ackModelLimitsReload: modelLimitRefresh.acknowledge,
      async close() {},
    };
  } else if (engine === "claude") {
    await prepareProviderGatewaySandbox(sandbox, ctx, engine, {
      rootOwnedClaudeCapability: layout.runsAsRoot,
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
      const lease = await prepareCodexSubscription({ sandbox, ctx, workdir, runtime: subscription });
      return {
        authPath: "subscription",
        authEpoch: lease.authEpoch,
        hasCurrentEpochThreadBinding: lease.hasCurrentEpochThreadBinding,
        readiness: null,
        modelLimitsChanged: false,
        modelLimitsRevision: null,
        modelLimitsChangedAt: null,
        async ackModelLimitsReload() {},
        close: () => lease.close(),
      };
    }
    await prepareProviderGatewaySandbox(sandbox, ctx, engine);
  }

  if (engine === "claude") {
    await prepareClaudeRuntimeAccess(sandbox, workdir);
    return {
      authPath: null,
      authEpoch: null,
      hasCurrentEpochThreadBinding: false,
      readiness: claudeProviderReadiness(claudeEnvironment),
      modelLimitsChanged: false,
      modelLimitsRevision: null,
      modelLimitsChangedAt: null,
      async ackModelLimitsReload() {},
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
  const layout = runtimeBridgeLayout(sandbox);
  await ensureSandboxBun(sandbox, layout, AbortSignal.timeout(180_000));
  for (const engine of ["codex", "claude", "opencode"] as const) {
    await ensureSelectedRuntimeProviderBootstrap(
      sandbox,
      engine,
      engine === "claude" ? claudeProviderGatewayEnvironment() : {},
      layout,
      AbortSignal.timeout(180_000),
    );
  }
}

export function resetRuntimeProviderBridgeCacheForTest(): void {
  bootstrapStates.clear();
}
