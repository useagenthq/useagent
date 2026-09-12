// The OpenCode global config a sandbox needs before the runtime starts it:
// the knowledge-gateway MCP entry and the provider-gateway options, merged
// into whatever the snapshot already carries. Read, prepare and write are
// separate so the runtime bridge can refresh a warm sandbox without a restart.
//
// TRUST BOUNDARY: the only thing that enters the untrusted sandbox is a
// short-lived, run-scoped bearer token, never database, embedding or tenant
// credentials. The gateway derives org, user and thread from that token.
import { BROWSER_MCP_SERVER_NAMES } from "./browser-mcp";
import type { EngineRunContext } from "./types";
import { toolGatewayConfig } from "../knowledge/gateway/config";
import {
  buildToolGatewayCapabilityDescriptor,
  describeToolGatewayCapabilityDescriptor,
  toOpenCodeKnowledgeMcpEntry,
  TOOL_GATEWAY_SERVER_NAMES,
} from "../knowledge/gateway/descriptor";
import {
  mergeOpenCodeProviderConfig,
  opencodeProviderGatewayOptions,
} from "../provider-gateway/sandbox-config";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  THREAD_TOKEN_REUSE_WINDOW_MS,
  ThreadTokenMemo,
  threadTokenMemoOptions,
} from "../util/token-memo";

type JsonObject = Record<string, unknown>;

// Thread-scoped token memo so warm turns build a byte-identical MCP entry
// (run-invariant config); a single-shot run keeps the strict run binding.
const opencodeToolTokens = new ThreadTokenMemo();

export interface OpenCodeGatewayState {
  readonly knowledge: boolean;
  readonly provider: boolean;
  readonly browser: boolean;
}

export interface PreparedOpenCodeConfig {
  readonly config: Record<string, unknown>;
  readonly state: OpenCodeGatewayState;
  readonly required: boolean;
}

export function buildOpencodeConfigWriteCommand(encodedConfig: string): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(encodedConfig)) {
    throw new Error("opencode config must be base64 encoded");
  }
  return (
    `mkdir -p ~/.config/opencode ~/work && chmod 700 ~/.config ~/.config/opencode && ` +
    `printf %s '${encodedConfig}' | base64 -d > ~/.config/opencode/opencode.json && ` +
    `chmod 600 ~/.config/opencode/opencode.json && ` +
    `rm -f -- ~/work/opencode.json`
  );
}

function setManagedMcpEntry(
  mcp: JsonObject,
  name: string,
  legacyName: string,
  value: unknown | null,
): void {
  if (value === null) delete mcp[name];
  else mcp[name] = value;
  delete mcp[legacyName];
}

/** Set (or clear) the two MCP entries this product manages; legacy names are always dropped. */
export function setUseAgentMcpEntries(
  mcp: JsonObject,
  knowledge: unknown | null,
  browser: unknown | null,
): void {
  setManagedMcpEntry(mcp, TOOL_GATEWAY_SERVER_NAMES[0], TOOL_GATEWAY_SERVER_NAMES[1], knowledge);
  setManagedMcpEntry(mcp, BROWSER_MCP_SERVER_NAMES[0], BROWSER_MCP_SERVER_NAMES[1], browser);
}

export async function readOpencodeSandboxConfig(
  sandbox: SandboxHandle,
): Promise<Record<string, unknown>> {
  const read = await sandbox.process
    .executeCommand("cat ~/.config/opencode/opencode.json 2>/dev/null || true", undefined, undefined, 10)
    .catch(() => null);
  const existing = (read?.result ?? "").trim();
  if (!existing) return {};
  try {
    return JSON.parse(existing) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Prepare the exact global OpenCode config for one run. The returned object is
 * minted once and reused unchanged by every later activation attempt, so the
 * token never drifts between attempts. A no-op unless the tool gateway is
 * configured and the run carries an org identity; preparation failure is
 * fail-closed whenever the gateway is required.
 */
export async function prepareOpencodeSandboxConfig(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
  baseConfig?: Record<string, unknown>,
): Promise<PreparedOpenCodeConfig | null> {
  const gw = toolGatewayConfig();
  const providerOptions = opencodeProviderGatewayOptions(ctx);
  // GUI automation is provided by the trusted knowledge computer_* tools, so any
  // stale browser MCP entry in retained configuration is removed.
  const browser = null;
  const state = {
    knowledge: Boolean(gw && ctx.orgId),
    provider: Object.keys(providerOptions).length > 0,
    browser: Boolean(browser),
  } satisfies OpenCodeGatewayState;
  if ((!ctx.orgId || (!gw && Object.keys(providerOptions).length === 0)) && !browser) {
    return { config: {}, state, required: false };
  }
  try {
    // Merge into any existing global config so snapshot-provided settings
    // (models, allowlists) survive. Read, parse and merge here; a shell JSON
    // merge is brittle.
    const cfg = baseConfig ?? await readOpencodeSandboxConfig(sandbox);
    cfg["$schema"] = cfg["$schema"] ?? "https://opencode.ai/config.json";
    const mcp = (typeof cfg.mcp === "object" && cfg.mcp ? (cfg.mcp as Record<string, unknown>) : {});
    let knowledgeMcp: ReturnType<typeof toOpenCodeKnowledgeMcpEntry> | null = null;
    if (gw && ctx.orgId) {
      const orgId = ctx.orgId;
      const descriptor = ctx.threadId
        ? (() => {
            const ttlMs = gw.tokenTtlMs;
            const nowMs = Date.now();
            const token = opencodeToolTokens.get(
              `${orgId}:${ctx.threadId}:${ctx.userId ?? ""}:tool`,
              threadTokenMemoOptions(ttlMs, THREAD_TOKEN_REUSE_WINDOW_MS),
              () => {
                const minted = buildToolGatewayCapabilityDescriptor(
                  {
                    orgId,
                    userId: ctx.userId ?? "",
                    threadId: ctx.threadId!,
                    runId: ctx.runId,
                  },
                  { config: gw, scope: "thread", ttlMs, nowMs },
                );
                if (!minted) throw new Error("tool gateway could not mint OpenCode capability");
                return minted.bearerToken;
              },
              nowMs,
            );
            return describeToolGatewayCapabilityDescriptor(
              {
                orgId,
                userId: ctx.userId ?? "",
                threadId: ctx.threadId,
                runId: ctx.runId,
              },
              { config: gw, scope: "thread", bearerToken: token, expiresAt: nowMs + ttlMs },
            );
          })()
        : buildToolGatewayCapabilityDescriptor(
            {
              orgId,
              userId: ctx.userId ?? "",
              threadId: ctx.runId,
              runId: ctx.runId,
            },
            { config: gw },
          );
      if (!descriptor) throw new Error("tool gateway could not mint OpenCode capability");
      knowledgeMcp = toOpenCodeKnowledgeMcpEntry(descriptor);
    }
    setUseAgentMcpEntries(mcp, knowledgeMcp, browser);
    cfg.mcp = mcp;
    const providers =
      typeof cfg.provider === "object" && cfg.provider
        ? (cfg.provider as Record<string, unknown>)
        : {};
    for (const [provider, options] of Object.entries(providerOptions)) {
      providers[provider] = mergeOpenCodeProviderConfig(
        provider,
        providers[provider],
        options,
      );
    }
    if (Object.keys(providerOptions).length > 0) cfg.provider = providers;
    console.log(
      `[opencode] sandbox gateways prepared for run ${ctx.runId} ` +
        `(knowledge=${state.knowledge} provider=${state.provider} browser=${state.browser})`,
    );
    return { config: cfg, state, required: true };
  } catch (e) {
    console.warn(
      `[opencode] sandbox config preparation failed:`,
      (e as Error).message,
    );
    return null;
  }
}

export async function writeOpencodeSandboxConfig(
  sandbox: SandboxHandle,
  config: Record<string, unknown>,
): Promise<void> {
  // Base64 keeps tokens and URLs out of shell parsing and logs. The global config
  // is private to the sandbox user and the repo-visible project copy is removed.
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  const result = await sandbox.process.executeCommand(
    buildOpencodeConfigWriteCommand(encoded),
    undefined,
    undefined,
    15,
  );
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("OpenCode sandbox config write failed");
  }
}
