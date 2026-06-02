import { createHash } from "node:crypto";
import type { ProviderId } from "../provider-gateway/provider";
import { providerForEngine } from "../provider-gateway/provider";
import {
  piProviderGatewayCapability,
  piToolGatewayDescriptor,
} from "../provider-gateway/sandbox-config";
import type { SandboxHandle } from "../sandboxes/provider";
import type { EngineRunContext } from "./types";

/** npm 18.0.3 corresponds to upstream main 160ed439 at integration time. */
export const PI_CODING_AGENT_VERSION = "18.0.3";
export const PI_CODING_AGENT_UPSTREAM_SHA = "160ed439ac0df594347e7d7018b813a7ffdb5e81";
export const PI_BRIDGE_GENERATION = 1;

interface PiModelSelection {
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly selector: string;
}

export interface PreparedPiRuntime {
  readonly model: PiModelSelection;
  readonly fingerprint: string;
  readonly knowledgeTools: boolean;
}

function modelSelection(model: string): PiModelSelection {
  const provider = providerForEngine("pi", model);
  if (!provider) throw new Error(`Pi cannot route model '${model}'`);
  const modelId = provider === "openai" ? model.replace(/^openai\//, "") : model;
  return { provider, modelId, selector: `${provider}/${modelId}` };
}

function apiFor(provider: ProviderId): "anthropic-messages" | "openai-responses" | "openrouter" {
  if (provider === "anthropic") return "anthropic-messages";
  if (provider === "openai") return "openai-responses";
  return "openrouter";
}

function providerConfig(ctx: EngineRunContext, selection: PiModelSelection): string {
  const capability = piProviderGatewayCapability(ctx, selection.provider);
  if (!capability) throw new Error("Pi provider gateway capability is unavailable");
  return JSON.stringify({
    providers: {
      [selection.provider]: {
        baseUrl: capability.baseUrl,
        apiKey: capability.bearerToken,
        api: apiFor(selection.provider),
        authHeader: true,
        models: [
          {
            id: selection.modelId,
            name: ctx.model ?? selection.modelId,
            api: apiFor(selection.provider),
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

function mcpConfig(ctx: EngineRunContext): { readonly json: string; readonly enabled: boolean } {
  const descriptor = piToolGatewayDescriptor(ctx);
  return {
    enabled: descriptor !== null,
    json: JSON.stringify({
      mcpServers: descriptor
        ? {
            [descriptor.serverName]: {
              type: "http",
              url: descriptor.url,
              headers: { Authorization: descriptor.authorizationHeader },
            },
          }
        : {},
    }),
  };
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

/** Installs the pinned Pi runtime once per retained sandbox and refreshes only
 * run-scoped model/MCP capability files on subsequent turns. */
export async function preparePiRuntime(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
  workdir: string,
): Promise<PreparedPiRuntime> {
  const selection = modelSelection(ctx.model?.trim() || "openai/gpt-5.6-luna");
  const modelJson = providerConfig(ctx, selection);
  const mcp = mcpConfig(ctx);
  const home = workdir.endsWith("/work") ? workdir.slice(0, -"/work".length) : `${workdir}/.home`;
  const agentDir = `${home}/.useagent/pi-home/agent`;
  const modelsPath = `${agentDir}/models.json`;
  const directories = await sandbox.process.executeCommand(
    `mkdir -p '${agentDir.replaceAll("'", "'\\''")}' '${workdir.replaceAll("'", "'\\''")}' && ` +
      `chmod 700 '${agentDir.replaceAll("'", "'\\''")}'`,
    undefined,
    undefined,
    20,
  );
  if ((directories.exitCode ?? 1) !== 0) throw new Error("failed to prepare Pi config directories");
  await Promise.all([
    uploadPrivateFile(sandbox, modelsPath, modelJson),
    uploadPrivateFile(sandbox, `${workdir}/.mcp.json`, mcp.json),
  ]);
  const install = await sandbox.process.executeCommand(
    `export PATH="$HOME/.local/bin:$PATH"; ` +
      `if ! command -v omp >/dev/null 2>&1 || ! omp --version 2>/dev/null | grep -Fq '${PI_CODING_AGENT_VERSION}'; then ` +
      `npm install -g --prefix "$HOME/.local" --silent '@oh-my-pi/pi-coding-agent@${PI_CODING_AGENT_VERSION}' >/dev/null; fi`,
    undefined,
    undefined,
    300,
  );
  if ((install.exitCode ?? 1) !== 0) {
    throw new Error(`failed to install Pi ${PI_CODING_AGENT_VERSION}`);
  }
  return {
    model: selection,
    fingerprint: createHash("sha256").update(modelJson).update("\0").update(mcp.json).digest("hex"),
    knowledgeTools: mcp.enabled,
  };
}
