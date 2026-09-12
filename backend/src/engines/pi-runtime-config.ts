import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ProviderId } from "../provider-gateway/provider";
import { providerForEngine } from "../provider-gateway/provider";
import {
  markProviderGatewaySandboxCurrent,
  piProviderGatewayCapability,
  piToolGatewayDescriptor,
} from "../provider-gateway/sandbox-config";
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { buildSandboxBunProbeCommand, ensureSandboxBun } from "./sandbox-bun";
import type { EngineRunContext } from "./types";
import { PI_BROKER_PORT, startPiCredentialBroker } from "./pi-credential-broker";

/** npm 18.0.3 corresponds to upstream main 160ed439 at integration time. */
export const PI_CODING_AGENT_VERSION = "18.0.3";
export const PI_BUN_VERSION = "1.3.14";
export const PI_CODING_AGENT_UPSTREAM_SHA = "160ed439ac0df594347e7d7018b813a7ffdb5e81";
export const PI_BRIDGE_GENERATION = 4;
export const PI_RUNTIME_LOCK_SHA256 = "a2f93ead170bc02603de81e80fbd3c678990d8204ce115932875f90e64c26847";
export const PI_RUNTIME_USER = "useagent-pi";
export const PI_RUNTIME_HOME = "/home/useagent-pi";
export const PI_RUNTIME_ROOT = "/opt/useagent/pi-runtime";

export interface PiModelSelection {
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly selector: string;
}

export interface PreparedPiRuntime {
  readonly model: PiModelSelection;
  readonly fingerprint: string;
  readonly knowledgeTools: boolean;
  readonly executable: string;
  readonly bunExecutable: string;
  readonly runAsUser: string | null;
  readonly home: string;
}

export function piModelSelection(model: string): PiModelSelection {
  const provider = providerForEngine("pi", model);
  if (!provider) throw new Error(`Pi cannot route model '${model}'`);
  const modelId = provider === "openai" ? model.replace(/^openai\//, "") : model;
  return { provider, modelId, selector: `${provider}/${modelId}` };
}

export function piApiForProvider(provider: ProviderId): "anthropic-messages" | "openai-responses" | "openai-completions" {
  if (provider === "anthropic") return "anthropic-messages";
  if (provider === "openai") return "openai-responses";
  // The UseAgent OpenRouter gateway exposes /v1/chat/completions. Pin Pi to
  // that concrete protocol instead of its dynamic `openrouter` transport,
  // which defaults to the unsupported Responses endpoint in Pi 18.0.3.
  return "openai-completions";
}

function providerConfig(ctx: EngineRunContext, selection: PiModelSelection): string {
  return JSON.stringify({
    providers: {
      [selection.provider]: {
        baseUrl: `http://127.0.0.1:${PI_BROKER_PORT}/provider`,
        apiKey: "useagent-broker",
        api: piApiForProvider(selection.provider),
        authHeader: true,
        models: [
          {
            id: selection.modelId,
            name: ctx.model ?? selection.modelId,
            api: piApiForProvider(selection.provider),
            reasoning: true,
            input: ["text", "image"],
            supportsTools: true,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            maxTokens: 64_000,
          },
        ],
      },
    },
  });
}

function mcpConfig(enabled: boolean): Record<string, unknown> {
  return {
    mcpServers: enabled
        ? {
            useagent: {
              type: "http",
              url: `http://127.0.0.1:${PI_BROKER_PORT}/mcp`,
            },
          }
        : {},
  } satisfies Record<string, unknown>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function uploadPiFile(
  sandbox: SandboxHandle,
  path: string,
  content: string,
): Promise<void> {
  await sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path, 60);
}

const runtimeFiles = Promise.all([
  readFile(new URL("../../pi-runtime/package.json", import.meta.url), "utf8"),
  readFile(new URL("../../pi-runtime/package-lock.json", import.meta.url), "utf8"),
]);

export function buildPiRuntimeInstallCommand(input: {
  readonly runtimeRoot: string;
  readonly runtimeManifestDir: string;
}): string {
  const { runtimeRoot, runtimeManifestDir } = input;
  return (
    `rm -f '${runtimeRoot}/.lock-sha256'; ` +
    `install -d -m 755 '${runtimeRoot}/current' && ` +
    `cp '${runtimeManifestDir}/package.json' '${runtimeManifestDir}/package-lock.json' '${runtimeRoot}/current/' && ` +
    `cd '${runtimeRoot}/current' && npm ci --omit=dev --silent`
  );
}

function buildPiRuntimeVerificationCommand(input: {
  readonly runtimeRoot: string;
  readonly bunExecutable: string;
  readonly executable: string;
  readonly requireCacheLock: boolean;
}): string {
  const { runtimeRoot, bunExecutable, executable, requireCacheLock } = input;
  const lock = `${runtimeRoot}/.lock-sha256`;
  const packageLock = `${runtimeRoot}/current/package-lock.json`;
  const cacheCheck = requireCacheLock
    ? `grep -Fxq '${PI_RUNTIME_LOCK_SHA256}' '${lock}' 2>/dev/null || exit 10; `
    : "";
  const commit = requireCacheLock
    ? ""
    : `printf '%s\\n' '${PI_RUNTIME_LOCK_SHA256}' > '${lock}'`;
  return (
    cacheCheck +
    `actual_lock="$(sha256sum -- '${packageLock}' 2>/dev/null | cut -d ' ' -f1)"; ` +
    `if test "$actual_lock" != '${PI_RUNTIME_LOCK_SHA256}'; then ` +
    `rm -f '${lock}'; printf '%s\\n' 'stage=verify package-lock mismatch' >&2; exit 21; fi; ` +
    `if ! '${bunExecutable}' --version | grep -Fxq '${PI_BUN_VERSION}'; then ` +
    `rm -f '${lock}'; printf '%s\\n' 'stage=verify Bun version mismatch' >&2; exit 22; fi; ` +
    `if ! '${bunExecutable}' '${executable}' --version | grep -Fxq 'omp/${PI_CODING_AGENT_VERSION}'; then ` +
    `rm -f '${lock}'; printf '%s\\n' 'stage=verify Pi version mismatch' >&2; exit 23; fi; ` +
    commit
  );
}

/** Verify-or-install as one script: exit 0 when the cached runtime already verifies. */
export function buildPiRuntimeEnsureCommand(input: {
  readonly runtimeRoot: string;
  readonly runtimeManifestDir: string;
  readonly bunExecutable: string;
  readonly executable: string;
}): string {
  const verification = {
    runtimeRoot: input.runtimeRoot,
    bunExecutable: input.bunExecutable,
    executable: input.executable,
  };
  return [
    `if ( ${buildPiRuntimeVerificationCommand({ ...verification, requireCacheLock: true })} ); then exit 0; fi`,
    `${buildPiRuntimeInstallCommand(input)} && ( ${buildPiRuntimeVerificationCommand({ ...verification, requireCacheLock: false })} )`,
  ].join("\n");
}

type PiRuntimeCommandProcess = Pick<SandboxHandle["process"], "executeCommand">;
type PiRuntimeCommandResult = Awaited<ReturnType<PiRuntimeCommandProcess["executeCommand"]>>;

function describePiRuntimeStage(stage: "install" | "verify", result: PiRuntimeCommandResult): string {
  const detail = (result.result ?? "").replace(/\s+/g, " ").trim().slice(-180);
  return `${stage} exit ${result.exitCode ?? "?"}${detail ? `: ${detail}` : ""}`;
}

export async function ensurePiRuntimeInstalled(input: {
  readonly process: PiRuntimeCommandProcess;
  readonly runtimeRoot: string;
  readonly runtimeManifestDir: string;
  readonly bunExecutable: string;
  readonly executable: string;
  readonly prepareCommand?: string;
}): Promise<void> {
  const verificationInput = {
    runtimeRoot: input.runtimeRoot,
    bunExecutable: input.bunExecutable,
    executable: input.executable,
  };
  const prepare = input.prepareCommand ? `(${input.prepareCommand}) || exit 30; ` : "";
  const cached = await input.process.executeCommand(
    prepare + buildPiRuntimeVerificationCommand({ ...verificationInput, requireCacheLock: true }),
    undefined,
    undefined,
    20,
  );
  if ((cached.exitCode ?? 1) === 0) return;
  if (cached.exitCode === 30) throw new Error("failed to finalize Pi runtime files");

  const install = await input.process.executeCommand(
    buildPiRuntimeInstallCommand(input),
    undefined,
    undefined,
    300,
  );
  const verification = await input.process.executeCommand(
    buildPiRuntimeVerificationCommand({ ...verificationInput, requireCacheLock: false }),
    undefined,
    undefined,
    20,
  );
  if ((verification.exitCode ?? 1) === 0) return;

  const stages = [
    ...(install.exitCode === 0 ? [] : [describePiRuntimeStage("install", install)]),
    describePiRuntimeStage("verify", verification),
  ];
  throw new Error(`failed to install Pi ${PI_CODING_AGENT_VERSION} (${stages.join("; ")})`);
}

/** Installs the pinned Pi runtime once per retained sandbox and refreshes only
 * run-scoped model/MCP capability files on subsequent turns. */
export async function preparePiRuntime(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
  workdir: string,
  layout: SandboxRuntimeLayout = { home: "/root", workdir: "/root/work", runsAsRoot: true },
): Promise<PreparedPiRuntime> {
  const selection = piModelSelection(ctx.model?.trim() || "openai/gpt-5.6-luna");
  const providerCapability = piProviderGatewayCapability(ctx, selection.provider);
  if (!providerCapability) throw new Error("Pi provider gateway capability is unavailable");
  const toolCapability = piToolGatewayDescriptor(ctx);
  const modelJson = providerConfig(ctx, selection);
  const mcpJson = JSON.stringify(mcpConfig(toolCapability !== null));
  const runtimeHome = layout.runsAsRoot ? PI_RUNTIME_HOME : `${layout.home}/.useagent/pi`;
  const runtimeRoot = layout.runsAsRoot ? PI_RUNTIME_ROOT : `${layout.home}/.useagent/pi-runtime`;
  const brokerRoot = layout.runsAsRoot ? "/root/.useagent/pi-broker" : `${layout.home}/.useagent/pi-broker`;
  const runAsUser = layout.runsAsRoot ? PI_RUNTIME_USER : null;
  const agentDir = `${runtimeHome}/agent`;
  const modelsPath = `${agentDir}/models.json`;
  const mcpPath = `${workdir}/.mcp.json`;
  const runtimeManifestDir = `${runtimeRoot}/manifest`;
  const runtimePackagePath = `${runtimeManifestDir}/package.json`;
  const runtimeLockPath = `${runtimeManifestDir}/package-lock.json`;
  const directoriesCommand = layout.runsAsRoot
    ? `id -u ${PI_RUNTIME_USER} >/dev/null 2>&1 || ` +
      `useradd --system --create-home --home-dir ${PI_RUNTIME_HOME} --shell /bin/sh ${PI_RUNTIME_USER}; ` +
      `chmod 711 /root && install -d -o ${PI_RUNTIME_USER} -g ${PI_RUNTIME_USER} -m 700 ` +
      `${shellQuote(agentDir)} ${shellQuote(workdir)} && ` +
      `chown -R ${PI_RUNTIME_USER}:${PI_RUNTIME_USER} ${shellQuote(workdir)} && ` +
      `install -d -o root -g root -m 700 ${shellQuote(brokerRoot)} && ` +
      `install -d -m 755 ${shellQuote(runtimeManifestDir)}`
    : `install -d -m 700 ${shellQuote(agentDir)} ${shellQuote(workdir)} ${shellQuote(brokerRoot)} && ` +
      `install -d -m 755 ${shellQuote(runtimeManifestDir)}`;
  const setupCommand = layout.bunExecutable
    ? `pi_directory_status=0; pi_bun_probe_status=0; ` +
      `timeout --signal=TERM --kill-after=1s 20s sh -c ${shellQuote(directoriesCommand)} ` +
      `& pi_directory_pid=$!; ` +
      `timeout --signal=TERM --kill-after=1s 15s sh -c ` +
      `${shellQuote(buildSandboxBunProbeCommand(layout))} & pi_bun_probe_pid=$!; ` +
      `wait "$pi_directory_pid" || pi_directory_status=$?; ` +
      `wait "$pi_bun_probe_pid" || pi_bun_probe_status=$?; ` +
      `test "$pi_directory_status" -eq 0 || exit 30; ` +
      `test "$pi_bun_probe_status" -eq 0 || exit 31`
    : `(${directoriesCommand}) || exit 30`;
  const directories = await sandbox.process.executeCommand(
    setupCommand,
    undefined,
    undefined,
    layout.bunExecutable ? 30 : 20,
  );
  if (directories.exitCode === 31 && layout.bunExecutable) {
    await ensureSandboxBun(sandbox, layout, ctx.signal);
  } else if ((directories.exitCode ?? 1) !== 0) {
    throw new Error("failed to prepare Pi config directories");
  }
  const [runtimePackageJson, runtimeLockJson] = await runtimeFiles;
  await Promise.all([
    uploadPiFile(sandbox, modelsPath, modelJson),
    uploadPiFile(sandbox, mcpPath, mcpJson),
    uploadPiFile(sandbox, runtimePackagePath, runtimePackageJson),
    uploadPiFile(sandbox, runtimeLockPath, runtimeLockJson),
  ]);
  if (layout.bunExecutable) ctx.signal.throwIfAborted();
  const bunExecutable = layout.bunExecutable ?? `${runtimeRoot}/current/node_modules/.bin/bun`;
  const executable = `${runtimeRoot}/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`;
  await ensurePiRuntimeInstalled({
    process: sandbox.process,
    runtimeRoot,
    runtimeManifestDir,
    bunExecutable,
    executable,
    prepareCommand:
      `chmod 600 -- ${shellQuote(modelsPath)} ${shellQuote(mcpPath)} ` +
      `${shellQuote(runtimePackagePath)} ${shellQuote(runtimeLockPath)}` +
      (layout.runsAsRoot
        ? ` && chown ${PI_RUNTIME_USER}:${PI_RUNTIME_USER} ${shellQuote(modelsPath)} ${shellQuote(mcpPath)}`
        : ""),
  });
  await startPiCredentialBroker({
    sandbox,
    provider: providerCapability,
    tools: toolCapability,
    root: brokerRoot,
  });
  // Warm runtime sandboxes are intentionally created without a run-scoped
  // provider capability. Mark the sandbox current only after Pi's private
  // broker and capability files are ready. Otherwise the next turn
  // rejects and deletes the retained sandbox as an obsolete credential
  // generation, silently breaking workspace continuity while the JSONL native
  // session still resumes.
  await markProviderGatewaySandboxCurrent(sandbox);
  return {
    model: selection,
    fingerprint: createHash("sha256").update(modelJson).update("\0").update(mcpJson).digest("hex"),
    knowledgeTools: toolCapability !== null,
    executable,
    bunExecutable,
    runAsUser,
    home: runtimeHome,
  };
}
