import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ProviderId } from "../provider-gateway/provider";
import { providerForEngine } from "../provider-gateway/provider";
import {
  piProviderGatewayCapability,
  piToolGatewayDescriptor,
} from "../provider-gateway/sandbox-config";
import type { SandboxHandle } from "../sandboxes/provider";
import type { EngineRunContext } from "./types";
import { PI_BROKER_PORT, startPiCredentialBroker } from "./pi-credential-broker";

/** npm 18.0.3 corresponds to upstream main 160ed439 at integration time. */
export const PI_CODING_AGENT_VERSION = "18.0.3";
export const PI_BUN_VERSION = "1.3.14";
export const PI_CODING_AGENT_UPSTREAM_SHA = "160ed439ac0df594347e7d7018b813a7ffdb5e81";
export const PI_BRIDGE_GENERATION = 2;
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
  readonly runAsUser: string;
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

async function uploadPrivateFile(
  sandbox: SandboxHandle,
  path: string,
  content: string,
): Promise<void> {
  await sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path, 60);
  const secured = await sandbox.process.executeCommand(
    `chmod 600 -- '${path.replaceAll("'", "'\\''")}'`,
    undefined,
    undefined,
    15,
  );
  if ((secured.exitCode ?? 1) !== 0) throw new Error(`failed to secure Pi config ${path}`);
}

const runtimeFiles = Promise.all([
  readFile(new URL("../../pi-runtime/package.json", import.meta.url), "utf8"),
  readFile(new URL("../../pi-runtime/package-lock.json", import.meta.url), "utf8"),
]);

/** Installs the pinned Pi runtime once per retained sandbox and refreshes only
 * run-scoped model/MCP capability files on subsequent turns. */
export async function preparePiRuntime(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
  workdir: string,
): Promise<PreparedPiRuntime> {
  const selection = piModelSelection(ctx.model?.trim() || "openai/gpt-5.6-luna");
  const providerCapability = piProviderGatewayCapability(ctx, selection.provider);
  if (!providerCapability) throw new Error("Pi provider gateway capability is unavailable");
  const toolCapability = piToolGatewayDescriptor(ctx);
  const modelJson = providerConfig(ctx, selection);
  const mcpJson = JSON.stringify(mcpConfig(toolCapability !== null));
  const agentDir = `${PI_RUNTIME_HOME}/agent`;
  const modelsPath = `${agentDir}/models.json`;
  const directories = await sandbox.process.executeCommand(
    `id -u ${PI_RUNTIME_USER} >/dev/null 2>&1 || ` +
      `useradd --system --create-home --home-dir ${PI_RUNTIME_HOME} --shell /bin/sh ${PI_RUNTIME_USER}; ` +
      `chmod 711 /root && install -d -o ${PI_RUNTIME_USER} -g ${PI_RUNTIME_USER} -m 700 ` +
      `'${agentDir.replaceAll("'", "'\\''")}' '${workdir.replaceAll("'", "'\\''")}' && ` +
      `chown -R ${PI_RUNTIME_USER}:${PI_RUNTIME_USER} '${workdir.replaceAll("'", "'\\''")}'`,
    undefined,
    undefined,
    20,
  );
  if ((directories.exitCode ?? 1) !== 0) throw new Error("failed to prepare Pi config directories");
  await Promise.all([
    uploadPrivateFile(sandbox, modelsPath, modelJson),
    uploadPrivateFile(sandbox, `${workdir}/.mcp.json`, mcpJson),
  ]);
  const ownership = await sandbox.process.executeCommand(
    `chown ${PI_RUNTIME_USER}:${PI_RUNTIME_USER} ` +
      `'${modelsPath.replaceAll("'", "'\\''")}' '${`${workdir}/.mcp.json`.replaceAll("'", "'\\''")}'`,
    undefined,
    undefined,
    15,
  );
  if ((ownership.exitCode ?? 1) !== 0) throw new Error("failed to assign Pi runtime configuration");
  const [runtimePackageJson, runtimeLockJson] = await runtimeFiles;
  const runtimeManifestDir = `${PI_RUNTIME_ROOT}/manifest`;
  await sandbox.process.executeCommand(`install -d -m 755 '${runtimeManifestDir}'`, undefined, undefined, 15);
  await Promise.all([
    uploadPrivateFile(sandbox, `${runtimeManifestDir}/package.json`, runtimePackageJson),
    uploadPrivateFile(sandbox, `${runtimeManifestDir}/package-lock.json`, runtimeLockJson),
  ]);
  const bunExecutable = `${PI_RUNTIME_ROOT}/current/node_modules/.bin/bun`;
  const executable = `${PI_RUNTIME_ROOT}/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`;
  const install = await sandbox.process.executeCommand(
    `if ! test -f '${PI_RUNTIME_ROOT}/.lock-sha256' || ` +
      `! grep -Fxq '${PI_RUNTIME_LOCK_SHA256}' '${PI_RUNTIME_ROOT}/.lock-sha256'; then ` +
      `install -d -m 755 '${PI_RUNTIME_ROOT}/current' && ` +
      `cp '${runtimeManifestDir}/package.json' '${runtimeManifestDir}/package-lock.json' '${PI_RUNTIME_ROOT}/current/' && ` +
      `cd '${PI_RUNTIME_ROOT}/current' && npm ci --omit=dev --silent >/dev/null && ` +
      `printf '%s\\n' '${PI_RUNTIME_LOCK_SHA256}' > '${PI_RUNTIME_ROOT}/.lock-sha256'; fi; ` +
      `'${bunExecutable}' '${executable}' --version | grep -Fq '${PI_CODING_AGENT_VERSION}'`,
    undefined,
    undefined,
    300,
  );
  if ((install.exitCode ?? 1) !== 0) {
    throw new Error(`failed to install Pi ${PI_CODING_AGENT_VERSION}`);
  }
  await startPiCredentialBroker({
    sandbox,
    provider: providerCapability,
    tools: toolCapability,
  });
  return {
    model: selection,
    fingerprint: createHash("sha256").update(modelJson).update("\0").update(mcpJson).digest("hex"),
    knowledgeTools: toolCapability !== null,
    executable,
    bunExecutable,
    runAsUser: PI_RUNTIME_USER,
    home: PI_RUNTIME_HOME,
  };
}
