import type { SandboxRuntimeLayout } from "../sandboxes/provider";
import { buildPendingCodexProviderConfigurationProbeCommand, INSTALL_VALIDATED } from "./runtime-codex-plan-config";
import { RUNTIME_ENVIRONMENT_WORKDIR } from "./runtime-environment";
import type { RuntimeEngineId } from "./runtime-orchestration";
import { buildSandboxBunProbeCommand } from "./sandbox-bun";

// The native engine versions the runtime bootstrap installs, and the read-only
// probes that prove an installed engine is exactly that package.
export const CODEX_VERSION = "0.162.1";
export const CLAUDE_CODE_VERSION = "2.1.296";
export const OPENCODE_VERSION = "2.0.26";
export const OPENCODE_PACKAGE = "@opencode/cli";
/** The pinned driver versions the bootstrap installs; the native image name is derived from them. */
export const RUNTIME_ENGINE_VERSIONS = {
  codex: CODEX_VERSION,
  claude: CLAUDE_CODE_VERSION,
  opencode: OPENCODE_VERSION,
} as const;
export const ROOT_RUNTIME_LAYOUT: SandboxRuntimeLayout = {
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
  'try{const packageRoot=fs.realpathSync(packageDirectory);const manifest=JSON.parse(fs.readFileSync(path.join(packageRoot,"package.json"),"utf8"));const binEntry=typeof manifest.bin==="string"?manifest.bin:manifest.bin?.opencode;const binaryReal=fs.realpathSync(binary);const relative=path.relative(packageRoot,binaryReal);const contained=relative!==""&&!relative.startsWith(".."+path.sep)&&!path.isAbsolute(relative);fs.accessSync(binary,fs.constants.X_OK);if(manifest.name!=="@opencode/cli"||manifest.version!==expectedVersion||binEntry!=="./bin/opencode.exe"||!contained||binaryReal!==fs.realpathSync(path.resolve(packageRoot,binEntry))||!fs.statSync(binaryReal).isFile())throw new Error("identity_mismatch");const fd=fs.openSync(binaryReal,"r"),magic=Buffer.alloc(4);try{if(fs.readSync(fd,magic,0,4,0)!==4||!magic.equals(Buffer.from([127,69,76,70])))throw new Error("not_native_elf")}finally{fs.closeSync(fd)}process.exit(0)}catch{if(diagnostic)console.error("useagent-native-version-probe: install_identity_mismatch expected="+expectedVersion);process.exit(1)}',
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
  return `node -e ${JSON.stringify(OPENCODE_INSTALL_IDENTITY_SCRIPT)} ${JSON.stringify(`${prefix}/bin/opencode`)} ${JSON.stringify(`${prefix}/share/useagent/native-engines/node_modules/${OPENCODE_PACKAGE}`)} ${JSON.stringify(OPENCODE_VERSION)} ${diagnostic ? "diagnostic" : "quiet"}`;
}

/** A bootstrapped sandbox's install check: Bun, the engine's identity and (Codex) its pending revision. */
export function buildRuntimeProviderValidationCommand(
  engine: RuntimeEngineId,
  layout: SandboxRuntimeLayout,
  pendingRevision: string | null,
): string {
  return [
    "set -eu",
    buildSandboxBunProbeCommand(layout),
    engine === "codex"
      ? buildCodexInstallIdentityProbeCommand(layout)
      : engine === "claude"
        ? buildClaudeInstallIdentityProbeCommand(layout)
        : buildOpenCodeInstallIdentityProbeCommand(layout),
    ...(pendingRevision
      ? [`echo ${INSTALL_VALIDATED}`, buildPendingCodexProviderConfigurationProbeCommand(pendingRevision)]
      : []),
  ].join("\n");
}
