import {
  sandboxPreviewHeaders,
  sandboxProvider,
  sandboxProviderApiKey,
  sandboxProviderKind,
  sandboxTemplate,
  type SandboxHandle,
} from "../sandboxes/provider";
import { providerEventExists, recordProviderEvent } from "../runs/provider-events";
import type {
  EmitStep,
  EngineAdapter,
  EngineRunContext,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessCheckpoint,
  HarnessOperationResult,
  HarnessReconciliation,
  HarnessSessionHandle,
} from "./types";
import { composeTurnPrompt } from "./types";
import { basename, parseJsonLine, persistSandboxBeforeExecution, truncate } from "./util";
import { getThreadSandbox, setRunSandbox } from "../runs/repo";
import { prepareRepos, shq } from "./repo-prep";
import { assertNever } from "../util/exhaustive";
import { nextPollDelayMs, stagesTogether } from "../util/startup";
import { toolGatewayConfig } from "../knowledge/gateway/config";
import {
  ACP_COMMANDS_EVENT_TYPE,
  SESSION_STARTED_EVENT_TYPE,
  normalizeOpencodeCommands,
  type CanonicalCommand,
} from "@skynet/agent-harness/canonical";
import { sessionCapabilities } from "./capabilities";
import { mintToolToken } from "../knowledge/gateway/token";
import { ThreadTokenMemo } from "../util/token-memo";
import { createHash } from "node:crypto";
import { MEMORY_SKILL_PATH, memorySkillText } from "../memory/memory-skill-text";
import {
  composeSecretEnv,
  materializeSecretFiles,
  PROVIDER_SECRET_NAMES,
  recordSecretsInjected,
  SECRET_DOTENV_PATH,
  SECRET_SOURCE_COMMAND,
} from "../secrets/inject";
import { revalidateCommandBeforeDispatch } from "../runs/command-intent";
import {
  markProviderGatewaySandboxCurrent,
  providerGatewaySandboxLabels,
  opencodeProviderGatewayOptions,
  providerGatewaySandboxIsCurrent,
  providerGatewayWired,
} from "../provider-gateway/sandbox-config";
import { opencodeAssistantError } from "./opencode-message";
import { ensureSandboxDesktopView } from "./desktop";
import { createSecretRedactor } from "../secrets/redact";
import { DEFAULT_OPENCODE_MODEL } from "../runs/model-policy";
import {
  forgetOpenCodeThreadServer,
  getOpenCodeThreadServer,
  rememberOpenCodeThreadServer,
  type OpenCodeThreadServer,
} from "./opencode-runtime";
import {
  questionEventId,
  parseOpenCodeQuestionRequest,
} from "./opencode-question";
import {
  activateOpenCodeRuntimeConfig,
  verifyOpenCodeRuntimeConfig,
  type OpenCodeRuntimeServer,
} from "./opencode-runtime-config";
import {
  forgetLiveThreadSandbox,
  getLiveThreadSandbox,
  rememberLiveThreadSandbox,
} from "./sandbox-runtime";
import {
  assertSandboxResources,
  resolveSandboxResourceTarget,
  sandboxMeetsResourceTarget,
} from "./daytona-resources";
import { claimCubeWarmSandbox } from "../sandboxes/cube-warm-pool";

// ---------------------------------------------------------------------------
// NATIVE opencode engine — the realtime path. Instead of one-shot CLI runs, the
// thread's Daytona sandbox runs a persistent `opencode serve` (the same server
// opencode's own web UI speaks to). The backend talks to it directly through
// the sandbox preview link: REST to create/prompt sessions, the global `/event`
// SSE for token-level text deltas and live tool state. Sessions are held BY THE
// ENGINE in memory/disk and resumed by id (runs.engine_session_id), so
// continuity is first-party, streaming is push (no polling), and the same
// sandbox port model later carries the interactive terminal.
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = DEFAULT_OPENCODE_MODEL;
const SERVE_PORT = 4096;
const OPENCODE_VERSION = "1.18.7";
const SERVER_PROCESS_SESSION = "skynet-opencode-serve";

// Run-invariant config (perf slice): thread-scoped tool tokens memoized so warm
// turns build byte-identical MCP config, and the hash of the last SUCCESSFULLY
// activated config per thread+sandbox so an unchanged warm config skips the
// PATCH + poll cycle (a single fast verify still proves it live; any failure
// falls back to the full activation/restart path - fail closed unchanged).
const opencodeToolTokens = new ThreadTokenMemo();
const TOOL_TOKEN_REUSE_MS = 8 * 60 * 60 * 1000;
const threadActivatedConfigHash = new Map<string, string>();

function configHash(config: Record<string, unknown>): string {
  return createHash("md5").update(JSON.stringify(config)).digest("hex");
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

function authHeaders(token: string): Record<string, string> {
  return sandboxPreviewHeaders(token);
}

function modelBody(model: string): { providerID: string; modelID: string } {
  return model.includes("/")
    ? { providerID: "openrouter", modelID: model }
    : { providerID: "anthropic", modelID: model };
}

/** Bun's fetch accepts a per-request `timeout` (ms; 0 = disable) that neither the
 *  DOM `RequestInit` nor Bun's own `BunFetchRequestInit` type declares, yet the
 *  runtime honours (Bun PR #33647). Typed honestly here so the long-stream fetches
 *  can disable Bun's 5-min idle cap without an `as any`/`as RequestInit` bypass. */
type FetchInit = RequestInit & { timeout?: number };

const FILE_TOOLS = new Set(["write", "edit", "patch", "multiedit"]);

/** Render an opencode Part's tool call as a step (same grammar as the CLI
 *  JSONL path — the server streams the identical Part model). */
function toolStep(
  tool: string,
  input: Record<string, unknown>,
  title: string | undefined,
  output: string | undefined,
): EmitStep {
  const code = { tool, input, ...(output !== undefined ? { output } : {}) };
  if (tool === "task") {
    const desc = String(input.description ?? title ?? "subagent");
    return {
      kind: "task",
      label: `Subagent — ${truncate(desc, 50)}`,
      chip: "subagent",
      code_json: code,
    };
  }
  const isFile = FILE_TOOLS.has(tool.toLowerCase());
  const filePath = (input.filePath as string) ?? (input.file_path as string) ?? "";
  const label = isFile
    ? filePath
      ? basename(filePath)
      : title ?? tool
    : (input.command as string) ?? title ?? tool;
  return {
    kind: isFile ? "file" : "command",
    label: truncate(String(label)),
    chip: isFile ? "file" : tool === "bash" ? "bash" : tool,
    code_json: code,
  };
}

/** Boot (or confirm) `opencode serve` inside the sandbox and resolve its
 *  preview endpoint + the sandbox user's workdir. Idempotent per sandbox.
 *
 *  Startup and readiness are deliberately separate operations. Keeping a shell
 *  probe loop inside one Daytona command lets repeated slow probes consume the
 *  daemon's entire execution timeout and yields an opaque 408. The backend can
 *  instead poll OpenCode's real health endpoint through the same preview link
 *  used for the session, with one bounded fetch per attempt. */
async function ensureServer(
  sandbox: SandboxHandle,
  npx: boolean,
  signal: AbortSignal,
): Promise<OpenCodeRuntimeServer> {
  const bin = npx ? `npx -y opencode-ai@${OPENCODE_VERSION}` : "opencode";
  const homeResult = await sandbox.process.executeCommand(
    'mkdir -p ~/work && printf %s "$HOME"',
    undefined,
    undefined,
    15,
  );
  if ((homeResult.exitCode ?? 1) !== 0) throw new Error("opencode workspace preparation failed");
  const home = homeResult.result?.trim() || "/home/daytona";
  const link = await sandbox.getPreviewLink(SERVE_PORT);
  const baseUrl = link.url.replace(/\/+$/, "");
  const token = link.token ?? "";
  const server = { baseUrl, token, workdir: `${home}/work` };

  // A healthy resident process survives turns and is always reused. When the
  // sandbox was stopped/restarted, recreate Daytona's dedicated background
  // session: executeCommand is synchronous even with shell `&`, whereas an
  // async session command is Daytona's supported long-lived-process primitive.
  const initialStatus = await opencodeHealthStatus(server, signal);
  if (initialStatus === null || initialStatus < 200 || initialStatus >= 300) {
    await sandbox.process.deleteSession(SERVER_PROCESS_SESSION).catch(() => {});
    await sandbox.process.createSession(SERVER_PROCESS_SESSION);
    await sandbox.process.executeSessionCommand(
      SERVER_PROCESS_SESSION,
      {
        command: `${SECRET_SOURCE_COMMAND} && cd ${shq(`${home}/work`)} && exec ${bin} serve --hostname 0.0.0.0 --port ${SERVE_PORT}`,
        runAsync: true,
        suppressInputEcho: true,
      },
      30,
    );
  }

  const deadline = Date.now() + 120_000;
  let lastStatus: number | null = null;
  // Bounded exponential polling (perf plan Phase 1): a server that is ready in
  // 200ms is seen in ~200ms instead of at the next full-second tick; the overall
  // deadline is unchanged.
  let pollDelay: number | null = null;
  while (Date.now() < deadline && !signal.aborted) {
    lastStatus = await opencodeHealthStatus(server, signal);
    if (lastStatus !== null && lastStatus >= 200 && lastStatus < 300) {
      return server;
    }
    const delay = nextPollDelayMs(pollDelay);
    pollDelay = delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (signal.aborted) throw new Error("opencode run aborted (timeout)");
  let logs: { output?: string; stderr?: string; stdout?: string } | null = null;
  try {
    const session = await sandbox.process.getSession(SERVER_PROCESS_SESSION);
    const command = session.commands.at(-1);
    if (command?.id) {
      logs = await sandbox.process.getSessionCommandLogs(SERVER_PROCESS_SESSION, command.id);
    }
  } catch {
    // Readiness already failed. Logs are diagnostic only and must not mask the
    // stable, redacted error below.
  }
  const safeTail = (logs?.output ?? logs?.stderr ?? logs?.stdout ?? "")
    .replace(/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<capability>")
    .trim();
  throw new Error(
    `opencode serve failed readiness${lastStatus ? ` (HTTP ${lastStatus})` : ""}: ${truncate(safeTail, 200)}`,
  );
}

/** Prime a newly created Cube sandbox's OpenCode executable and preview route
 * without retaining a process that predates run-scoped secret materialization.
 * The real turn still starts a clean server after writing its 0600 dotenv. */
export async function prewarmOpenCodeRuntime(
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<void> {
  const secretFile = SECRET_DOTENV_PATH.startsWith("$HOME/")
    ? `"$HOME/${SECRET_DOTENV_PATH.slice("$HOME/".length)}"`
    : shq(SECRET_DOTENV_PATH);
  const prepared = await sandbox.process.executeCommand(
    `mkdir -p "$(dirname ${secretFile})" "$HOME/work" && ` +
      `chmod 700 "$(dirname ${secretFile})" && ` +
      `touch ${secretFile} && chmod 600 ${secretFile}`,
    undefined,
    undefined,
    15,
  );
  if ((prepared.exitCode ?? 1) !== 0) {
    throw new Error("OpenCode prewarm workspace preparation failed");
  }
  try {
    await ensureServer(sandbox, false, signal);
  } finally {
    await sandbox.process.deleteSession(SERVER_PROCESS_SESSION).catch(() => {});
  }
}

async function opencodeHealthStatus(
  server: OpenCodeRuntimeServer,
  signal: AbortSignal,
): Promise<number | null> {
  try {
    const response = await fetch(`${server.baseUrl}/global/health`, {
      headers: authHeaders(server.token),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    const status = response.status;
    await response.body?.cancel().catch(() => {});
    return status;
  } catch {
    return null;
  }
}

async function reuseHealthyResidentServer(
  cached: OpenCodeThreadServer | null,
  sandboxId: string,
  signal: AbortSignal,
): Promise<OpenCodeRuntimeServer | null> {
  if (!cached || cached.sandboxId !== sandboxId) return null;
  const status = await opencodeHealthStatus(cached, signal);
  return status !== null && status >= 200 && status < 300 ? cached : null;
}

/** Stop the resident process and prove its preview endpoint is no longer serving
 * before a fallback restart. Swallowing delete errors can otherwise let
 * ensureServer observe the old healthy process and dispatch with stale config. */
async function stopServerForConfigReload(
  sandbox: SandboxHandle,
  server: OpenCodeRuntimeServer,
  signal: AbortSignal,
): Promise<void> {
  let deletionFailed = false;
  try {
    await sandbox.process.deleteSession(SERVER_PROCESS_SESSION);
  } catch {
    deletionFailed = true;
  }
  const deadline = Date.now() + 10_000;
  do {
    const status = await opencodeHealthStatus(server, signal);
    if (status === null || status < 200 || status >= 300) return;
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  } while (!signal.aborted && Date.now() < deadline);
  throw new Error(
    deletionFailed
      ? "OpenCode config fallback could not stop the resident server"
      : "OpenCode resident server remained healthy after stop",
  );
}

// shq / repo cloning live in the shared engine-neutral ./repo-prep (imported above).

/**
 * Prepare the exact global OpenCode config for one run. The returned object is
 * minted once and is reused unchanged by the live-update and restart-fallback
 * paths, preventing token drift between activation attempts.
 *
 * TRUST BOUNDARY: the ONLY thing that enters the untrusted sandbox is a
 * short-lived, run-scoped bearer TOKEN — never DB/embedding/tenant credentials.
 * The gateway derives org/user/thread from that token server-side. We write the
 * MCP entry into opencode's GLOBAL config (`~/.config/opencode/opencode.json`)
 * — merged with any snapshot config, immune to a repo clone into the workspace,
 * and loaded at `opencode serve` boot for a fresh sandbox. Warm turns apply it
 * to the already-healthy server before any prompt dispatch.
 *
 * Gated: a no-op unless GATEWAY_PUBLIC_URL is set (the sandbox-reachable,
 * gateway-only origin) AND the run carries an org identity. Preparation failure
 * is fail-closed whenever the provider gateway is required.
 *
 * Fresh servers receive it on disk before boot. Warm servers receive it through
 * OpenCode's authenticated global-config endpoint, which rebuilds provider/MCP
 * instance state without killing the process.
 */
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

export async function prepareOpencodeSandboxConfig(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
  baseConfig?: Record<string, unknown>,
): Promise<PreparedOpenCodeConfig | null> {
  const gw = toolGatewayConfig();
  const providerOptions = opencodeProviderGatewayOptions(ctx);
  // GUI automation is provided by the trusted skynet-knowledge computer_* tools.
  // Remove any stale Playwright MCP entry from retained OpenCode configuration.
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
    // Merge into any existing global config so snapshot-provided settings (models,
    // allowlists) survive. Read-parse-merge in TS (a shell JSON merge is brittle).
    const cfg = baseConfig ?? await readOpencodeSandboxConfig(sandbox);
    cfg["$schema"] = cfg["$schema"] ?? "https://opencode.ai/config.json";
    const mcp = (typeof cfg.mcp === "object" && cfg.mcp ? (cfg.mcp as Record<string, unknown>) : {});
    if (gw && ctx.orgId) {
      const orgId = ctx.orgId;
      // Thread-scoped + memoized so warm turns build a byte-identical MCP entry
      // (run-invariant config); a single-shot run keeps the strict run binding.
      const token = ctx.threadId
        ? opencodeToolTokens.get(
            `${orgId}:${ctx.threadId}:${ctx.userId ?? ""}:tool`,
            // Turn-cover TTL + reuse window; refresh when remaining validity
            // drops below the turn-cover TTL (same guarantee as a run token).
            { ttlMs: gw.tokenTtlMs + TOOL_TOKEN_REUSE_MS, refreshMarginMs: gw.tokenTtlMs },
            () =>
              mintToolToken(
                {
                  orgId,
                  userId: ctx.userId ?? "",
                  threadId: ctx.threadId!,
                  runId: ctx.runId,
                  scope: "thread",
                },
                gw.tokenTtlMs + TOOL_TOKEN_REUSE_MS,
              ),
          )
        : mintToolToken(
            {
              orgId,
              userId: ctx.userId ?? "",
              threadId: ctx.runId,
              runId: ctx.runId,
            },
            gw.tokenTtlMs,
          );
      mcp["skynet-knowledge"] = {
        type: "remote",
        url: gw.mcpUrl,
        enabled: true,
        headers: { Authorization: `Bearer ${token}` },
      };
    } else delete mcp["skynet-knowledge"];
    if (browser) mcp["skynet-browser"] = browser;
    else delete mcp["skynet-browser"];
    cfg.mcp = mcp;
    const providers =
      typeof cfg.provider === "object" && cfg.provider
        ? (cfg.provider as Record<string, unknown>)
        : {};
    for (const [provider, options] of Object.entries(providerOptions)) {
      const existing =
        typeof providers[provider] === "object" && providers[provider]
          ? (providers[provider] as Record<string, unknown>)
          : {};
      const existingOptions =
        typeof existing.options === "object" && existing.options
          ? (existing.options as Record<string, unknown>)
          : {};
      providers[provider] = { ...existing, options: { ...existingOptions, ...options } };
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
  // Base64 keeps tokens/URLs out of shell parsing and logs. The global config is
  // private to the sandbox user and the repo-visible project copy is removed.
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

/**
 * Overwrite the v17 snapshot's `/memory` skill (new_mem_prompt.md section 7) with
 * honest, tools-based text BEFORE `opencode serve` boots, so the resident agent
 * uses the Tencent-backed memory TOOLS instead of the snapshot's false claim that
 * `/root/.skynet/memory.md` "is synced back ... and reloaded into your next
 * session". Base64 write (no shell-escaping hazard, nothing sensitive here).
 * Best-effort: a failure logs and continues (the corrected text is not
 * load-bearing for authorization, only guidance). A WARM resumed thread already
 * loaded the old skill; fresh sandboxes (the common case) always get the fix.
 *
 * `hasTools` = whether the memory TOOLS were actually wired for this run. When
 * false the text explicitly forbids claiming a durable save or writing a local
 * memory file (the observed no-gateway failure mode) - honesty over pretend tools.
 */
async function correctMemorySkillText(sandbox: SandboxHandle, hasTools: boolean): Promise<void> {
  try {
    const b64 = Buffer.from(memorySkillText(hasTools), "utf8").toString("base64");
    await sandbox.process.executeCommand(
      `mkdir -p "$(dirname ${shq(MEMORY_SKILL_PATH)})" && printf %s '${b64}' | base64 -d > ${shq(MEMORY_SKILL_PATH)}`,
      undefined,
      undefined,
      15,
    );
  } catch (e) {
    console.warn(`[opencode] memory skill correction failed (continuing):`, (e as Error).message);
  }
}

/** Parse one SSE frame's data payload (we only care about `data:` lines). */
function sseData(frame: string): Record<string, unknown> | null {
  const dataLines = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return null;
  return parseJsonLine(dataLines.join(""));
}

// ---------------------------------------------------------------------------
// Boot reconciliation (north star "Crash Recovery Matrix" #8: provider completed
// but Skynet still says running). A bounded, side-effect-free probe of a stale
// run's native session — used by src/runs/recovery.ts on restart. It NEVER wakes
// a stopped sandbox (that would be slow and violates "don't wake a sandbox to
// read history") and NEVER throws: every failure resolves to `unreachable` so
// boot can fall back to the honest interrupted-and-resumable summary.
// ---------------------------------------------------------------------------

export type OpencodeReconcile =
  /** Native session is idle with a completed assistant message newer than our
   *  last step — its text is the real run summary. */
  | { outcome: "completed"; summary: string }
  /** Sandbox stopped/gone/unhealthy, or the probe timed out. */
  | { outcome: "unreachable" }
  /** Session exists but the last assistant message is still generating. */
  | { outcome: "in_progress" }
  /** Session reachable but nothing completed newer than our last step. */
  | { outcome: "no_new_message" };

type OcMessage = {
  info?: {
    id?: string;
    role?: string;
    time?: { created?: number; completed?: number };
    error?: unknown;
  };
  parts?: { type?: string; text?: string }[];
};

/** Resolve an already-running sandbox's resident opencode endpoint (base URL,
 *  preview token, `?directory=` scope). Returns null when the sandbox is
 *  unconfigured, gone, or NOT already `started` — we never wake a stopped
 *  sandbox just to read/cancel (north star: don't wake to read history). Shared
 *  by reconcile + cancel; never throws. */
async function openResidentServer(
  sandboxId: string,
): Promise<{ baseUrl: string; token: string; dirQ: string } | null> {
  const apiKey = sandboxProviderApiKey();
  if (apiKey === undefined) return null;
  try {
    const provider = sandboxProvider(apiKey);
    const sandbox = await provider.get(sandboxId).catch(() => null);
    if (!sandbox) return null;
    if ((sandbox as { state?: string }).state !== "started") return null;
    // Resolve the session's workdir (the same `?directory=` scope the turn used).
    const homeRes = await sandbox.process
      .executeCommand('printf %s "$HOME"', undefined, undefined, 4)
      .catch(() => null);
    const home = homeRes?.result?.trim() || "/home/daytona";
    const dirQ = `?directory=${encodeURIComponent(`${home}/work`)}`;
    const link = await sandbox.getPreviewLink(SERVE_PORT);
    return { baseUrl: link.url.replace(/\/+$/, ""), token: link.token ?? "", dirQ };
  } catch {
    return null;
  }
}

/** Bounded (~9s internal) native-session probe for restart recovery. Reads the
 *  session's message history from the resident opencode server (only if the
 *  sandbox is already `started`) and decides whether the interrupted run in fact
 *  finished server-side. */
export async function reconcileOpencodeRun(input: {
  sandboxId: string;
  sessionId: string;
  /** Our last recorded step time (epoch ms). A completed assistant message must
   *  be strictly newer than this to count as THIS turn's result (a resumed
   *  session also holds earlier turns' completed messages). */
  sinceMs: number;
}): Promise<OpencodeReconcile> {
  const ac = new AbortController();
  const budget = setTimeout(() => ac.abort(), 9_000);
  try {
    const server = await openResidentServer(input.sandboxId);
    if (!server) return { outcome: "unreachable" };
    const res = await fetch(
      `${server.baseUrl}/session/${input.sessionId}/message${server.dirQ}`,
      { headers: authHeaders(server.token), signal: ac.signal },
    );
    if (!res.ok) return { outcome: "unreachable" };

    const msgs = (await res.json()) as OcMessage[];
    const assistants = msgs.filter((m) => m.info?.role === "assistant");
    const last = assistants[assistants.length - 1];
    if (!last) return { outcome: "no_new_message" };

    const completed = last.info?.time?.completed;
    if (typeof completed !== "number") return { outcome: "in_progress" };
    if (completed <= input.sinceMs) return { outcome: "no_new_message" };

    const text = (last.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.trim())
      .map((p) => p.text as string)
      .join("\n")
      .trim();
    return { outcome: "completed", summary: truncate(text || "opencode run completed", 2000) };
  } catch {
    return { outcome: "unreachable" };
  } finally {
    clearTimeout(budget);
  }
}

// ---------------------------------------------------------------------------
// Typed harness seam (north star Phase 2 "HarnessAdapter Contract"), Stage-1
// minimal: capabilities / cancel / reconcile as a thin facade over the resident
// opencode server. It does NOT re-drive turns (EngineAdapter.run still does);
// it exposes the typed control/observability surface the product layer needs.
// ---------------------------------------------------------------------------

/** opencode v1.18.7 native capabilities (what the harness provides, not what
 *  Skynet already projects). */
const OPENCODE_CAPABILITIES: HarnessCapabilities = {
  resume: true, // resumes a native session by id
  cancel: true, // POST /session/:id/abort
  streaming: "parts", // /event message.part.updated + inline token deltas
  authoritativeHistory: true, // REST message history reconciled as truth
  childSessions: true, // task tool + child sessions with parentID
  approvals: true, // native permission asked/replied events
  questions: true, // native question asked/replied events
  reasoning: true, // reasoning parts
  todos: true, // GET /session/:id/todo
  patches: true, // GET /session/:id/diff, patch/file parts
  usage: true, // token usage on assistant messages
};

export const opencodeHarness: HarnessAdapter = {
  provider: "opencode",

  capabilities(): HarnessCapabilities {
    return { ...OPENCODE_CAPABILITIES };
  },

  async cancel(
    handle: HarnessSessionHandle,
    _reason: string,
  ): Promise<HarnessOperationResult> {
    // Defensive: a provider whose capabilities().cancel is false returns a typed
    // unsupported result rather than a silent no-op (opencode's is true).
    if (!OPENCODE_CAPABILITIES.cancel) {
      return { status: "unsupported_capability", provider: "opencode", capability: "cancel" };
    }
    const ac = new AbortController();
    const budget = setTimeout(() => ac.abort(), 9_000);
    try {
      const server = await openResidentServer(handle.sandboxId);
      if (!server) {
        return { status: "error", code: "sandbox_unreachable", message: "resident opencode server not reachable" };
      }
      const res = await fetch(
        `${server.baseUrl}/session/${handle.sessionId}/abort${server.dirQ}`,
        { method: "POST", headers: authHeaders(server.token), signal: ac.signal },
      );
      return res.ok
        ? { status: "ok" }
        : { status: "error", code: "abort_failed", message: `HTTP ${res.status}` };
    } catch (err) {
      return {
        status: "error",
        code: "cancel_failed",
        message: err instanceof Error ? err.message : "unknown cancel error",
      };
    } finally {
      clearTimeout(budget);
    }
  },

  async reconcile(
    handle: HarnessSessionHandle,
    checkpoint?: HarnessCheckpoint,
  ): Promise<HarnessReconciliation> {
    const r = await reconcileOpencodeRun({
      sandboxId: handle.sandboxId,
      sessionId: handle.sessionId,
      sinceMs: checkpoint?.sinceMs ?? 0,
    });
    // Map the opencode-native outcome onto the provider-neutral projection.
    switch (r.outcome) {
      case "completed":
        return { status: "completed", summary: r.summary };
      case "in_progress":
        return { status: "in_progress" };
      case "no_new_message":
        return { status: "no_change" };
      case "unreachable":
        return { status: "unreachable" };
      default:
        return assertNever(r, "unhandled opencode reconcile outcome");
    }
  },
};

export const opencodeServerAdapter: EngineAdapter = {
  id: "opencode",

  async run(ctx: EngineRunContext): Promise<void> {
    const apiKey = sandboxProviderApiKey();
    if (apiKey === undefined) throw new Error("opencode engine needs sandbox provider credentials");
    if (!providerGatewayWired()) {
      throw new Error("opencode engine requires a configured provider gateway");
    }
    const startedAt = Date.now();
    const provider = sandboxProvider(apiKey);
    const budgetMs = Number(process.env.ENGINE_TIMEOUT_MS ?? 600_000);

    // Org secrets live in a protected dotenv materialized as FILES after the
    // sandbox exists (materializeSecretFiles below), and OpenCode sources it
    // explicitly at boot (SECRET_SOURCE_COMMAND) - correctness never depends on
    // create-time env. So the create passes NO custom env: that is exactly what
    // makes an OpenCode create eligible for a Daytona warm pool (a pool serves
    // only creates that use the snapshot's default user with no custom env,
    // volumes, or secrets). The BASH_ENV compatibility path is baked into the
    // snapshot image instead (build-opencode-snapshot.ts). Raw provider
    // credentials are never placed in an untrusted sandbox regardless - the
    // generated OpenCode provider config points only at the trusted gateway. The
    // names-only marker is recorded only after the files are materialized.
    const secretInjection = await composeSecretEnv(ctx, {
      excludeNames: PROVIDER_SECRET_NAMES,
    });
    const redact = createSecretRedactor(secretInjection.redactionValues);

    const snapshot = sandboxTemplate("DAYTONA_SNAPSHOT", "skynet-agent-v17");
    const resourceTarget = resolveSandboxResourceTarget();
    let sandbox: SandboxHandle | null = null;
    let npxFallback = false;
    let retainForThread = false;
    let persistedForThread = false;

    try {
      // ── sandbox: reuse the thread's (memory cache → durable DB mapping) ─────
      const endSandboxSpan = ctx.timing?.begin("sandbox");
      const rememberedServer = ctx.threadId ? getOpenCodeThreadServer(ctx.threadId) : null;
      const rememberedId =
        rememberedServer?.sandboxId ??
        (ctx.threadId ? await getThreadSandbox(ctx.threadId) : null);
      if (rememberedId) {
        try {
          const cachedSandbox = ctx.threadId ? getLiveThreadSandbox(ctx.threadId) : null;
          const prior =
            cachedSandbox?.id === rememberedId
              ? cachedSandbox
              : await provider.get(rememberedId);
          const state = (prior as { state?: string }).state;
          if (state === "stopped" || state === "paused" || state === "archived") {
            await ctx.emit({ kind: "task", label: `Resuming thread sandbox ${prior.id.slice(0, 8)}…`, chip: "opencode" });
            await prior.start();
          } else if (state !== "started") {
            throw new Error(`unusable state: ${state}`);
          }
          if (!(await providerGatewaySandboxIsCurrent(prior))) {
            await prior.delete().catch(() => {});
            throw new Error("legacy sandbox credential generation");
          }
          sandbox = prior;
          retainForThread = true;
        } catch {
          if (ctx.threadId) {
            forgetOpenCodeThreadServer(ctx.threadId);
            forgetLiveThreadSandbox(ctx.threadId, rememberedId);
          }
          sandbox = null;
        }
      }
      if (sandbox && !sandboxMeetsResourceTarget(sandbox, resourceTarget)) {
        const staleId = sandbox.id;
        await sandbox.delete().catch(() => {});
        if (ctx.threadId) {
          forgetOpenCodeThreadServer(ctx.threadId);
          forgetLiveThreadSandbox(ctx.threadId, staleId);
        }
        sandbox = null;
        retainForThread = false;
        await ctx.emit({
          kind: "task",
          label: "Replacing an undersized retained sandbox…",
          chip: "opencode",
        });
      }

      // Stop quickly (a stopped sandbox keeps its disk at ~zero cost and
      // restarts in seconds; ensureServer re-boots `opencode serve` on wake),
      // but keep the thread's world alive for DAYS before deletion.
      const autoStopInterval = Number(process.env.SANDBOX_AUTO_STOP_MIN ?? 30);
      const autoDeleteInterval = Number(process.env.SANDBOX_AUTO_DELETE_MIN ?? 4320); // 3 days
      const provisionedFresh = !sandbox;
      if (provisionedFresh) {
        await ctx.emit({ kind: "task", label: "Provisioning cloud sandbox…", chip: "opencode" });
        if (sandboxProviderKind() === "cube") {
          sandbox = await claimCubeWarmSandbox();
          if (sandbox) {
            await ctx.emit({
              kind: "task",
              label: `Claimed warm sandbox ${sandbox.id.slice(0, 8)}`,
              chip: "opencode",
            });
          }
        }
      }
      if (provisionedFresh && !sandbox) {
        try {
          // No `envVars`: keeps this create warm-pool eligible (see the secret
          // injection note above). Labels + auto-stop/delete do not disqualify a
          // pool claim.
          sandbox = await provider.create({
            snapshot,
            labels: providerGatewaySandboxLabels(ctx.runId),
            autoStopInterval,
            autoDeleteInterval,
          });
        } catch {
          sandbox = await provider.create({
            labels: providerGatewaySandboxLabels(ctx.runId),
            autoStopInterval,
            autoDeleteInterval,
          });
          npxFallback = true;
        }
      }
      if (!sandbox) throw new Error("Sandbox provider returned no sandbox");
      const box = sandbox;
      const resources = assertSandboxResources(box, resourceTarget);
      if (provisionedFresh) {
        await ctx.emit({
          kind: "task",
          label: `Sandbox ${box.id.slice(0, 8)} ready in ${Math.round((Date.now() - startedAt) / 1000)}s (${resources.cpu} CPU / ${resources.memory} GiB)`,
          chip: "opencode",
        });
      }
      if (ctx.signal.aborted) throw new Error("opencode run aborted (timeout)");

      // Durable thread→sandbox mapping BEFORE we boot the server / run tools: the DB row
      // survives restarts (the in-memory map is just a preview cache). AWAITED + FAIL-CLOSED
      // (same invariant as ACP): if the association cannot be recorded we abort the turn
      // rather than run in a box the terminal/preview/file/cleanup routes can't resolve, and
      // a box we JUST provisioned is torn down (a reused resident box is kept for the thread).
      try {
        await persistSandboxBeforeExecution({
          runId: ctx.runId,
          sandboxId: box.id,
          reused: retainForThread,
          persist: setRunSandbox,
          deleteFreshSandbox: () => box.delete(),
        });
      } catch (error) {
        // persistSandboxBeforeExecution already deletes a fresh box. Clear the
        // reference so this adapter's finally block cannot delete it twice.
        if (!retainForThread) sandbox = null;
        throw error;
      }
      if (ctx.threadId) {
        rememberLiveThreadSandbox(ctx.threadId, box);
        persistedForThread = true;
      }
      endSandboxSpan?.();

      await ctx.emit({
        kind: "task",
        label: "Preparing browser, tools, and integrations…",
        chip: "opencode",
      });
      const endPrepareSpan = ctx.timing?.begin("prepare");
      const prepareStage = async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
        const end = ctx.timing?.begin(`prepare.${stage}`);
        try {
          return await operation();
        } finally {
          end?.();
        }
      };

      // These probes are independent on a warm sandbox. Run them together so
      // Daytona control-plane latency is paid once rather than serially. The
      // cached server is only trusted after a live health response from the same
      // sandbox; if it is absent/unhealthy, ensureServer starts it AFTER the
      // current secret files are materialized so a resumed process cannot inherit
      // stale or revoked credentials.
      const [desktop, cachedRuntimeServer, , baseOpenCodeConfig] = await stagesTogether([
        () => prepareStage("desktop", () => ensureSandboxDesktopView(box, ctx.signal)),
        () =>
          prepareStage("resident_probe", () =>
            reuseHealthyResidentServer(rememberedServer, box.id, ctx.signal),
          ),
        () =>
          prepareStage("secrets", () =>
            materializeSecretFiles(
              (cmd) => box.process.executeCommand(cmd, undefined, undefined, 30),
              secretInjection.files,
            ),
          ),
        () => prepareStage("base_config", () => readOpencodeSandboxConfig(box)),
      ]);

      // Prepare run-scoped gateways. A fresh server
      // reads this config from disk at boot; a warm server applies the same
      // immutable payload through OpenCode's runtime config API below.
      if (!desktop.available) {
        await ctx.emit({
          kind: "task",
          label: desktop.reason ?? "Desktop computer-use tools unavailable in this sandbox",
          chip: "warning",
        });
      }
      const [preparedConfig] = await Promise.all([
        prepareStage("config_merge", () =>
          prepareOpencodeSandboxConfig(box, ctx, baseOpenCodeConfig),
        ),
        prepareStage("secret_marker", () => recordSecretsInjected(ctx, secretInjection)),
      ]);
      const gatewayState = preparedConfig?.state ?? {
        knowledge: false,
        provider: false,
        browser: false,
      };
      if (providerGatewayWired() && !gatewayState.provider) {
        throw new Error("provider gateway config could not be installed in the sandbox");
      }
      if (!retainForThread && preparedConfig?.required) {
        await prepareStage("config_write", () =>
          writeOpencodeSandboxConfig(box, preparedConfig.config),
        );
      }

      // Replace the snapshot's false-persistence memory skill with text that
      // matches the capability actually negotiated for this turn. It is not an
      // authorization boundary, so it can run alongside warm runtime activation.
      // Lazy + memoized so the serial-startup rollback flag genuinely sequences
      // it (an eagerly-started promise would still race under the flag).
      let memoryCorrectionStarted: Promise<void> | null = null;
      const memoryCorrection = (): Promise<void> =>
        (memoryCorrectionStarted ??= correctMemorySkillText(box, gatewayState.knowledge));
      endPrepareSpan?.();

      await ctx.emit({ kind: "task", label: "Starting agent runtime…", chip: "opencode" });
      const endRuntimeSpan = ctx.timing?.begin("runtime");

      // ── persistent server + preview endpoint ────────────────────────────────
      let runtimeServer =
        cachedRuntimeServer ?? await ensureServer(box, npxFallback, ctx.signal);
      const activateRuntime = async (): Promise<void> => {
        try {
          if (preparedConfig?.required) {
            // Run-invariant fast path: thread-scoped memoized tokens make the warm
            // config byte-stable, so when its hash matches the last SUCCESSFUL
            // activation on this exact thread+sandbox, skip the PATCH + rebuild
            // poll and only run one verify (fast when already active). Any
            // mismatch or verify failure takes the full activate/restart path.
            const desiredHash = configHash(preparedConfig.config);
            const hashKey = ctx.threadId ? `${ctx.threadId}:${box.id}` : null;
            const configUnchanged =
              retainForThread && hashKey !== null &&
              threadActivatedConfigHash.get(hashKey) === desiredHash;
            if (retainForThread) {
              try {
                await stagesTogether([
                  memoryCorrection,
                  () =>
                    configUnchanged
                      ? verifyOpenCodeRuntimeConfig({
                          server: runtimeServer,
                          config: preparedConfig.config,
                          sessionId: ctx.engineSessionId,
                          signal: ctx.signal,
                          timeoutMs: 3_000,
                        })
                      : activateOpenCodeRuntimeConfig({
                          server: runtimeServer,
                          config: preparedConfig.config,
                          sessionId: ctx.engineSessionId,
                          signal: ctx.signal,
                        }),
                ]);
              } catch (error) {
                await memoryCorrection();
                console.warn(
                  `[opencode] runtime config activation failed; restarting resident server:`,
                  error instanceof Error ? error.message : "unknown activation error",
                );
                await writeOpencodeSandboxConfig(box, preparedConfig.config);
                await stopServerForConfigReload(box, runtimeServer, ctx.signal);
                runtimeServer = await ensureServer(box, npxFallback, ctx.signal);
                await verifyOpenCodeRuntimeConfig({
                  server: runtimeServer,
                  config: preparedConfig.config,
                  sessionId: ctx.engineSessionId,
                  signal: ctx.signal,
                });
              }
            } else {
              await memoryCorrection();
              await verifyOpenCodeRuntimeConfig({
                server: runtimeServer,
                config: preparedConfig.config,
                signal: ctx.signal,
              });
            }
            // Record only after the config is PROVEN active (either lane above threw
            // otherwise), so the fast path can never trust an unproven config.
            if (hashKey) threadActivatedConfigHash.set(hashKey, desiredHash);
          } else {
            await memoryCorrection();
          }
          // Daytona labels are the credential-generation trust anchor. The marker is
          // written only after the config is proven active, never before activation.
          if (!retainForThread) await markProviderGatewaySandboxCurrent(box);
        } finally {
          endRuntimeSpan?.();
        }
      };

      // Repository validation/cloning and runtime activation touch independent
      // resources. Both remain prompt-dispatch gates, but neither waits for the
      // other on the normal path. The serial rollback flag preserves the former
      // runtime-then-repositories order.
      const prepareRepositories = async (): Promise<void> => {
        const endReposSpan = ctx.timing?.begin("repos");
        try {
          await prepareRepos(box, runtimeServer.workdir, ctx);
        } finally {
          endReposSpan?.();
        }
      };
      await stagesTogether([activateRuntime, prepareRepositories]);

      const { baseUrl, token, workdir } = runtimeServer;
      if (ctx.threadId) {
        rememberOpenCodeThreadServer(ctx.threadId, {
          sandboxId: box.id,
          baseUrl,
          token,
          workdir,
        });
        retainForThread = true;
      }
      const headers = { ...authHeaders(token), "content-type": "application/json" };
      const dirQ = `?directory=${encodeURIComponent(workdir)}`;

      const createSession = async (): Promise<string> => {
        const res = await fetch(`${baseUrl}/session${dirQ}`, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
          signal: ctx.signal,
        });
        if (!res.ok) throw new Error(`opencode session create failed: HTTP ${res.status}`);
        const id = String(((await res.json()) as { id?: string }).id ?? "");
        if (!id) throw new Error("opencode session create returned no id");
        ctx.saveEngineSessionId?.(id);
        return id;
      };

      // Resume the thread's native session; a stored id may predate this server
      // (CLI-era session in a dead sandbox) — the prompt POST 404s then and we
      // fall back to a fresh session WITH the composed preamble.
      let sessionId = ctx.engineSessionId ?? null;
      let resumed = Boolean(sessionId);
      if (!sessionId) sessionId = await createSession();
      // Resumed turns must ALSO stamp the id on THEIR run row — a thread whose
      // only stamped run gets deleted (or a race) would otherwise go dark for
      // the Live tab even though the session exists.
      else ctx.saveEngineSessionId?.(sessionId);

      const recordSessionStarted = (id: string): void => {
        void recordProviderEvent({
          id: `${ctx.runId}:${id}:session`,
          runId: ctx.runId,
          threadId: ctx.threadId ?? ctx.runId,
          provider: "opencode",
          eventType: SESSION_STARTED_EVENT_TYPE,
          nativeSessionId: id,
          payload: {
            source: "opencode",
            capabilities: sessionCapabilities("opencode", {
              desktop: desktop.available,
              knowledgeTools: gatewayState.knowledge,
            }),
          },
        });
      };
      recordSessionStarted(sessionId);

      // Capture the provider's CURRENT replacement catalog concurrently with
      // the turn. Ordinary prompts do not pay this fetch in TTFT; every capture
      // is joined before return so the provider-event drain cannot seal first.
      // A command turn awaits the same task immediately before dispatch and
      // fails closed unless the durable capture succeeded and still contains
      // the accepted command.
      const captureCommandCatalog = async (id: string): Promise<readonly CanonicalCommand[] | null> => {
        if (ctx.signal.aborted) return null;
        try {
          const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(8_000)]);
          const res = await fetch(`${baseUrl}/command${dirQ}`, {
            headers: authHeaders(token),
            signal,
          });
          if (!res.ok) return null;
          const parsed = await res.json().catch(() => null);
          if (!Array.isArray(parsed)) return null;
          const commands = normalizeOpencodeCommands(parsed);
          const frame = {
            id: `${ctx.runId}:${id}:commands`,
            runId: ctx.runId,
            threadId: ctx.threadId ?? ctx.runId,
            provider: "opencode",
            eventType: ACP_COMMANDS_EVENT_TYPE,
            nativeSessionId: id,
            payload: { source: "opencode", commands, ts: Date.now() },
          };
          for (let attempt = 0; attempt < 3; attempt++) {
            await recordProviderEvent(frame, { critical: true });
            if (await providerEventExists(frame.id)) return commands;
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
          }
        } catch {
          // Core chat remains available; native-command dispatch fails closed
          // against a null live catalog.
        }
        return null;
      };
      const catalogCaptures: Promise<readonly CanonicalCommand[] | null>[] = [];
      const startCatalogCapture = (id: string): Promise<readonly CanonicalCommand[] | null> => {
        const task = captureCommandCatalog(id);
        catalogCaptures.push(task);
        return task;
      };
      let liveCatalog = startCatalogCapture(sessionId);

      // ── realtime: subscribe /event BEFORE prompting ─────────────────────────
      const sseAbort = new AbortController();
      const onParentAbort = () => sseAbort.abort();
      ctx.signal.addEventListener("abort", onParentAbort, { once: true });

      // Live translation state: text deltas by part id; tool steps by part id.
      // Subagents run in CHILD sessions (parentID chains to ours) — track them so
      // their tool activity renders (↳-tagged) instead of being filtered out.
      const childSessions = new Set<string>();
      const textLen = new Map<string, number>();
      // Reasoning ("thinking") deltas by part id - streamed live as a subdued
      // Thinking affordance ahead of the answer. Tracked separately from textLen
      // so a reasoning part and an answer part never share a cursor.
      const reasoningLen = new Map<string, number>();
      // message id → role, from message.updated events. The engine emits
      // part updates for the USER'S own prompt message too — streaming those
      // echoed the prompt into live narration (user-reported).
      const messageRoles = new Map<string, string>();
      const textParts = new Map<string, string>(); // ordered final text parts
      const toolSteps = new Map<string, string>(); // part id → persisted step id
      const toolDone = new Set<string>();
      const emittedSubagents = new Set<string>(); // subagent descriptions shown (dedupe subtask ↔ task tool)

      // Translate one opencode Part (the v1 contract: message.part.updated
      // carries `properties.part`, token deltas ride inline on `properties.delta`)
      // into a durable step / delta.
      const handlePart = async (part: Record<string, unknown>, delta?: string): Promise<void> => {
        const sid = String(part.sessionID ?? "");
        const isChild = childSessions.has(sid);
        if (sid !== sessionId && !isChild) return;
        const partId = String(part.id ?? "");
        const p = part as Record<string, any>;

        // TEXT — the main turn's live narration. Child-session text is subagent
        // chatter; keep the parent delta channel clean (their TOOLS still render).
        if (part.type === "text") {
          if (isChild) return;
          const mid = String(part.messageID ?? "");
          if (mid && messageRoles.get(mid) === "user") return;
          const text = typeof part.text === "string" ? (part.text as string) : "";
          // A NEW text part is a new paragraph — the engine emits one part per
          // burst, and joining them bare produced run-on prose ("…first.Chess.com
          // loaded…", user-reported). Separate at the part boundary.
          const isNewPart = !textLen.has(partId);
          const sep = isNewPart && textLen.size > 0 ? "\n\n" : "";
          if (typeof delta === "string" && delta.length > 0) {
            ctx.publishDelta?.(sep + delta);
            textLen.set(partId, text.length);
          } else {
            const prev = textLen.get(partId) ?? 0;
            if (text.length > prev) {
              ctx.publishDelta?.(sep + text.slice(prev));
              textLen.set(partId, text.length);
            }
          }
          if (text) textParts.set(partId, text);
          return;
        }

        // REASONING — provider "thinking" tokens (config `reasoning: true`).
        // Published LIVE as a distinct `reasoning` delta so the UI shows a subdued
        // "Thinking" affordance the moment the model starts reasoning, typically
        // seconds before any answer text. Live-only narration: durability is the
        // provider-event lane (capturePart records part.reasoning), which the
        // canonical translator maps to reasoning.delta/completed - so nothing here
        // emits a step or changes the persistence contract. Child-session
        // reasoning is subagent chatter; keep the parent channel clean.
        if (part.type === "reasoning") {
          if (isChild) return;
          const text = typeof part.text === "string" ? (part.text as string) : "";
          if (typeof delta === "string" && delta.length > 0) {
            ctx.publishDelta?.(delta, "reasoning");
            reasoningLen.set(partId, text.length);
          } else {
            const prev = reasoningLen.get(partId) ?? 0;
            if (text.length > prev) {
              ctx.publishDelta?.(text.slice(prev), "reasoning");
              reasoningLen.set(partId, text.length);
            }
          }
          return;
        }

        // SUBTASK — opencode's first-class "assistant spawned a subagent" part on
        // the parent session. Renders the subagent header; the matching `task`
        // ToolPart (deduped by description) carries the running→completed
        // lifecycle if it arrives.
        if (part.type === "subtask") {
          const desc = String(p.description ?? p.agent ?? "subagent");
          if (emittedSubagents.has(desc)) return;
          emittedSubagents.add(desc);
          const id = await ctx.emit({
            kind: "task",
            label: `Subagent — ${truncate(desc, 50)}`,
            chip: "subagent",
            code_json: {
              agent: p.agent,
              description: p.description,
              prompt: p.prompt,
              native: { sessionID: sid, partID: partId, childSessionID: p.sessionID ?? null },
            },
          });
          if (id) toolSteps.set(partId, id);
          return;
        }

        // TOOL — emit at running, update-in-place at completed/error via the
        // toolSteps pairing. `task` → "Subagent — …" (chip subagent); child-
        // session tools get a "↳ " prefix.
        if (part.type === "tool" && typeof part.tool === "string") {
          const st = (p.state ?? {}) as {
            status?: string;
            input?: Record<string, unknown>;
            output?: string;
            error?: string;
            title?: string;
          };
          if (toolDone.has(partId)) return;
          const status = st.status;
          const isTask = part.tool === "task";
          const taskDesc = isTask ? String((st.input?.description as string) ?? st.title ?? "subagent") : "";
          const active = status === "running" || status === "completed" || status === "error";
          if (!toolSteps.has(partId) && active) {
            // Skip if a subtask part already rendered this subagent (no lifecycle
            // row to update, so a second row would just duplicate).
            if (isTask && emittedSubagents.has(taskDesc)) {
              toolDone.add(partId);
            } else {
              const step = toolStep(part.tool, st.input ?? {}, st.title, undefined);
              const native = {
                sessionID: sid,
                messageID: typeof part.messageID === "string" ? part.messageID : null,
                partID: partId,
                callID: typeof part.callID === "string" ? part.callID : null,
              };
              step.code_json =
                step.code_json && typeof step.code_json === "object"
                  ? { ...(step.code_json as Record<string, unknown>), native }
                  : { native };
              if (isChild) step.label = `↳ ${step.label}`;
              if (isTask) emittedSubagents.add(taskDesc);
              const id = await ctx.emit(step);
              if (id) toolSteps.set(partId, id);
            }
          }
          if ((status === "completed" || status === "error") && toolSteps.has(partId)) {
            toolDone.add(partId);
            const output = status === "error" ? String(st.error ?? "") : String(st.output ?? "");
            // The update REPLACES code_json wholesale — re-stamp the native ids
            // or the completion overwrite erases the running-state stamp.
            await ctx.updateStep?.(toolSteps.get(partId)!, {
              tool: part.tool,
              input: st.input ?? {},
              output: output.slice(0, 2000),
              // Preserve native tool error state (north star: stop dropping it).
              // The completion overwrite flattens `st.error` into `output`, so
              // without this flag the UI can't tell an errored tool from a
              // successful one that happened to print to stderr.
              error: status === "error",
              native: {
                sessionID: sid,
                messageID: typeof part.messageID === "string" ? part.messageID : null,
                partID: partId,
                callID: typeof part.callID === "string" ? part.callID : null,
              },
            });
          }
        }
      };

      // All part handling funnels through one serial chain — handlePart's
      // emit-once dedupe (check, await emit, set) is only atomic if two sources
      // (SSE pump / mid-turn poller / finalize) can never interleave on it.
      let partChain: Promise<void> = Promise.resolve();
      // Lossless native capture (north star Phase 1): persist every part — all
      // types, including ones the step translator ignores — keyed by native
      // part id (revisions upsert). Fire-and-forget; never blocks translation.
      // recordProviderEvent mints the seq + serializes persist→publish per run
      // (see provider-events.ts), so no local seq counter is needed here.
      const capturePart = (part: Record<string, unknown>): void => {
        const partId = String(part.id ?? "");
        if (!partId) return;
        const st = (part as { state?: { status?: string } }).state;
        void recordProviderEvent({
          id: `pe_${partId}`,
          runId: ctx.runId,
          threadId: ctx.threadId ?? ctx.runId,
          provider: "opencode",
          eventType: `part.${String(part.type ?? "unknown")}${st?.status ? `.${st.status}` : ""}`,
          nativeSessionId: typeof part.sessionID === "string" ? part.sessionID : null,
          nativeMessageId: typeof part.messageID === "string" ? part.messageID : null,
          nativePartId: partId,
          nativeCallId: typeof part.callID === "string" ? part.callID : null,
          payload: redact.unknown(part),
        });
      };
      const enqueuePart = (part: Record<string, unknown>, delta?: string): Promise<void> => {
        const safePart = redact.unknown(part);
        capturePart(safePart);
        const priorPart = partChain;
        partChain = (async () => {
          try {
            await priorPart;
            await handlePart(
              safePart,
              typeof delta === "string" ? redact.text(delta) : delta,
            );
          } catch {
            // A malformed provider part must not break ordering for later parts.
          }
        })();
        return partChain;
      };

      const pumpEvents = async (): Promise<void> => {
        // Workspace-scoped: /event WITHOUT ?directory attaches to the DEFAULT
        // workspace instance's bus and hears nothing from this session (probe:
        // 1 frame vs 39 for the same activity). This — not proxy buffering —
        // was the live-dead-air culprit; the poller stays as belt-and-braces.
        const res = await fetch(`${baseUrl}/event${dirQ}`, {
          headers: authHeaders(token),
          signal: sseAbort.signal,
          // Disable Bun's 5-min fetch idle timeout (BUN_CONFIG_HTTP_IDLE_TIMEOUT,
          // fixed to be overridable in Bun PR #33647) - this SSE is held open for
          // the whole turn and was being cut at ~5min, freezing live text.
          timeout: 0,
        } as FetchInit);
        if (!res.ok || !res.body) return;
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body) {
          // Normalize CRLF → LF so frame splitting on "\n\n" survives a proxy
          // that rewrites line endings (Daytona preview).
          buf += decoder.decode(chunk as Uint8Array, { stream: true }).replace(/\r\n/g, "\n");
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const ev = sseData(frame);
            if (!ev) continue;
            // v1 wraps payloads in `properties`; tolerate `data` in case a build
            // uses the newer envelope. Token deltas ride inline as `delta`.
            const rawProps = ((ev.properties ?? ev.data) ?? {}) as Record<string, unknown>;
            const props = rawProps as {
              part?: Record<string, unknown>;
              delta?: string;
              info?: { id?: string; parentID?: string; role?: string };
            };
            if (ev.type === "message.updated" && props.info?.id && props.info.role) {
              messageRoles.set(props.info.id, props.info.role);
            }
            // Register subagent sessions: any session whose parent chains to ours
            // (direct child OR a child of an already-tracked child).
            if (
              (ev.type === "session.created" || ev.type === "session.updated") &&
              props.info?.id &&
              props.info.parentID &&
              (props.info.parentID === sessionId || childSessions.has(props.info.parentID))
            ) {
              childSessions.add(props.info.id);
              void recordProviderEvent({
                id: `pe_${props.info.id}_lifecycle`,
                runId: ctx.runId,
                threadId: ctx.threadId ?? ctx.runId,
                provider: "opencode",
                eventType: ev.type,
                nativeSessionId: props.info.id,
                nativeParentSessionId: props.info.parentID ?? null,
                payload: props.info,
              });
            }
            if (ev.type === "question.asked") {
              const question = parseOpenCodeQuestionRequest(rawProps);
              if (
                question &&
                (question.sessionID === sessionId || childSessions.has(question.sessionID))
              ) {
                await recordProviderEvent(
                  {
                    id: questionEventId(ctx.runId, question.id, "asked"),
                    runId: ctx.runId,
                    threadId: ctx.threadId ?? ctx.runId,
                    provider: "opencode",
                    eventType: ev.type,
                    nativeSessionId: question.sessionID,
                    nativeMessageId: question.tool?.messageID ?? null,
                    nativeCallId: question.tool?.callID ?? null,
                    payload: question,
                  },
                  { critical: true },
                );
              }
            }
            if (ev.type === "question.replied" || ev.type === "question.rejected") {
              const requestId =
                typeof rawProps.requestID === "string" ? rawProps.requestID : null;
              const questionSessionId =
                typeof rawProps.sessionID === "string" ? rawProps.sessionID : null;
              if (
                requestId &&
                questionSessionId &&
                (questionSessionId === sessionId || childSessions.has(questionSessionId))
              ) {
                await recordProviderEvent(
                  {
                    id: questionEventId(
                      ctx.runId,
                      requestId,
                      ev.type === "question.replied" ? "replied" : "rejected",
                    ),
                    runId: ctx.runId,
                    threadId: ctx.threadId ?? ctx.runId,
                    provider: "opencode",
                    eventType: ev.type,
                    nativeSessionId: questionSessionId,
                    payload: rawProps,
                  },
                  { critical: true },
                );
              }
            }
            if (ev.type === "message.part.updated" && props.part) {
              await enqueuePart(props.part, typeof props.delta === "string" ? props.delta : undefined);
            }
          }
        }
      };
      const pump = pumpEvents().catch(() => {}); // SSE is additive; REST is truth

      // ── the turn: POST resolves when the assistant message completes ────────
      // Pre-turn snapshot (resumed sessions): the finalize step reconciles from
      // FULL session history, which on a resumed thread includes every earlier
      // turn — without this snapshot a reply re-emits the whole thread's past
      // tools into its own worklog (observed: a Paris essay turn wearing the
      // previous turn's stock-price subagents).
      const preTurnMessages = new Set<string>();
      const preTurnChildren = new Set<string>();
      if (resumed) {
        try {
          const [hres, cres] = await Promise.all([
            fetch(`${baseUrl}/session/${sessionId}/message${dirQ}`, { headers, signal: ctx.signal }),
            fetch(`${baseUrl}/session/${sessionId}/children${dirQ}`, { headers, signal: ctx.signal }),
          ]);
          if (hres.ok) {
            for (const m of (await hres.json()) as { info?: { id?: string } }[]) {
              if (m.info?.id) preTurnMessages.add(m.info.id);
            }
          }
          if (cres.ok) {
            for (const c of (await cres.json()) as { id?: string }[]) {
              if (c.id) preTurnChildren.add(c.id);
            }
          }
        } catch {
          /* snapshot is best-effort; worst case we over-reconcile like before */
        }
      }

      await ctx.emit({ kind: "task", label: "Thinking…", chip: "opencode" });
      const model = ctx.model?.trim() || DEFAULT_MODEL;
      const turnAbort = new AbortController();
      const timer = setTimeout(() => turnAbort.abort(), Math.max(10_000, budgetMs - (Date.now() - startedAt)));
      const onAbort2 = () => turnAbort.abort();
      ctx.signal.addEventListener("abort", onAbort2, { once: true });

      // Mid-turn history poller: the Daytona preview proxy sometimes buffers
      // the /event SSE stream entirely, leaving a working run invisible until
      // finalize. REST is reliable — poll parent + child histories and feed
      // tool/subtask parts through the same serialized translator (text stays
      // SSE-only: re-polling full text would fight the delta channel).
      const pollAbort = new AbortController();
      const poller = (async () => {
        while (!pollAbort.signal.aborted) {
          await new Promise((r) => setTimeout(r, 2500));
          if (pollAbort.signal.aborted) break;
          try {
            const cres = await fetch(`${baseUrl}/session/${sessionId}/children${dirQ}`, {
              headers,
              signal: pollAbort.signal,
            });
            if (cres.ok) {
              for (const c of (await cres.json()) as { id?: string }[]) {
                if (c.id && !preTurnChildren.has(c.id)) childSessions.add(c.id);
              }
            }
            for (const id of [sessionId, ...childSessions]) {
              const res = await fetch(`${baseUrl}/session/${id}/message${dirQ}`, {
                headers,
                signal: pollAbort.signal,
              });
              if (!res.ok) continue;
              const msgs = (await res.json()) as {
                info?: { id?: string };
                parts?: Record<string, unknown>[];
              }[];
              for (const m of msgs) {
                if (m.info?.id && preTurnMessages.has(m.info.id)) continue;
                for (const part of m.parts ?? []) {
                  if (part.type === "tool" || part.type === "subtask") await enqueuePart(part);
                }
              }
            }
          } catch {
            /* transient poll failure — next tick retries */
          }
        }
      })();

      ctx.timing?.mark("dispatch");
      const postPrompt = async (text: string): Promise<Response> =>
        fetch(`${baseUrl}/session/${sessionId}/message${dirQ}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: modelBody(model),
            parts: [{ type: "text", text }],
          }),
          signal: turnAbort.signal,
          // The turn's reply arrives only at the END, so this socket is "idle" the
          // whole time and Bun cut it at 5min (BUN_CONFIG_HTTP_IDLE_TIMEOUT). Disable
          // per-request (Bun PR #33647) so a long turn completes on the connection.
          timeout: 0,
        } as FetchInit);

      let reply: OcMessage;
      // The turn is driven by ONE long-held POST to the sandbox's opencode server
      // through the Daytona preview proxy, which severs long/idle connections
      // (~255s). A turn that runs longer than that (deep research, big evals) loses
      // the POST connection while STILL RUNNING server-side. So a dropped POST that
      // is NOT our own abort is RECOVERABLE: the turn keeps going and we detect its
      // completion by polling the session history (a session runs as long as it
      // needs; the sliding inactivity window stays the only cap, resetting on the
      // live tool events the mid-turn poller keeps feeding).
      const turnStartMs = Date.now();
      const waitForCompletion = async (): Promise<typeof reply> => {
        while (!ctx.signal.aborted) {
          await new Promise((r) => setTimeout(r, 3000));
          const r = await fetch(`${baseUrl}/session/${sessionId}/message${dirQ}`, {
            headers,
            signal: ctx.signal,
          }).catch(() => null);
          if (!r?.ok) continue;
          const msgs = (await r.json()) as OcMessage[];
          const last = msgs.filter((m) => m.info?.role === "assistant").at(-1);
          const completed = last?.info?.time?.completed;
          if (typeof completed === "number" && completed > turnStartMs) {
            return last ?? {};
          }
        }
        throw new Error("opencode run aborted (timeout)");
      };
      // Post the prompt; tolerate the proxy cutting the long connection (poll then).
      const postOrPoll = async (text: string): Promise<Response | null> => {
        try {
          return await postPrompt(text);
        } catch (postErr) {
          if (ctx.signal.aborted) throw postErr; // our own abort → fatal below
          return null; // proxy severed the long POST — turn still runs; poll for it
        }
      };
      const assertCommandAuthorized = async (
        id: string,
        catalog: Promise<readonly CanonicalCommand[] | null>,
      ): Promise<void> => {
        if (!ctx.commandName) return;
        const reason = revalidateCommandBeforeDispatch(
          {
            name: ctx.commandName,
            provider: ctx.commandProvider ?? null,
            sessionId: ctx.commandSessionId ?? null,
            catalogRevision: ctx.commandCatalogRevision ?? null,
          },
          { engine: "opencode", sessionId: id, catalog: await catalog },
        );
        if (reason) {
          throw new Error(
            `stale command "/${ctx.commandName}" rejected before dispatch: ${reason} - re-issue it against the current session`,
          );
        }
      };
      try {
        await assertCommandAuthorized(sessionId, liveCatalog);
        let res = await postOrPoll(composeTurnPrompt(ctx, resumed));
        if (res && res.status === 404 && resumed) {
          // Stale resume id (session from a previous sandbox/server incarnation)
          // — start fresh WITH the full bootstrap + per-turn context. A command
          // accepted for the old session is rejected before any retry; ordinary
          // prompts may safely continue in the replacement session.
          sessionId = await createSession();
          resumed = false;
          recordSessionStarted(sessionId);
          liveCatalog = startCatalogCapture(sessionId);
          if (ctx.commandName) {
            const reason = revalidateCommandBeforeDispatch(
              {
                name: ctx.commandName,
                provider: ctx.commandProvider ?? null,
                sessionId: ctx.commandSessionId ?? null,
                catalogRevision: ctx.commandCatalogRevision ?? null,
              },
              { engine: "opencode", sessionId, catalog: null },
            );
            throw new Error(
              `stale command "/${ctx.commandName}" rejected before dispatch: ${reason ?? "session replaced"} - re-issue it against the current session`,
            );
          }
          res = await postOrPoll(composeTurnPrompt(ctx, false));
        }
        if (res === null) {
          reply = await waitForCompletion();
        } else if (!res.ok) {
          throw new Error(`opencode prompt failed: HTTP ${res.status} ${truncate(await res.text(), 200)}`);
        } else {
          reply = (await res.json()) as typeof reply;
        }
      } catch (err) {
        // Best-effort: tell the engine to stop the turn we abandoned.
        void fetch(`${baseUrl}/session/${sessionId}/abort${dirQ}`, { method: "POST", headers }).catch(() => {});
        throw err instanceof Error && err.name === "AbortError"
          ? new Error("opencode run aborted (timeout)")
          : err;
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort2);
        // Give trailing SSE frames a beat to land, then close the stream.
        await new Promise((r) => setTimeout(r, 300));
        sseAbort.abort();
        pollAbort.abort();
        ctx.signal.removeEventListener("abort", onParentAbort);
        await pump;
        await poller;
        await Promise.all(catalogCaptures);
      }

      const assistantError = opencodeAssistantError(reply.info?.error);
      if (assistantError) throw new Error(`opencode provider failed: ${assistantError}`);

      // ── finalize from the AUTHORITATIVE session history ─────────────────────
      // The SSE pump is best-effort: a buffering preview proxy can withhold every
      // frame until the stream closes, and a multi-message turn leaves tool parts
      // in an earlier assistant message the POST reply never returns (it returns
      // only the FINAL message). So reconcile the durable log from the server's
      // own message history — the parent session plus every subagent (child)
      // session — through the SAME translator. handlePart's toolSteps / toolDone /
      // emittedSubagents maps dedupe anything the pump already streamed live.
      const reconcileSession = async (id: string, child: boolean): Promise<void> => {
        if (child) childSessions.add(id);
        try {
          const res = await fetch(`${baseUrl}/session/${id}/message${dirQ}`, { headers, signal: ctx.signal });
          if (!res.ok) return;
          const msgs = (await res.json()) as {
            info?: { id?: string };
            parts?: Record<string, unknown>[];
          }[];
          for (const m of msgs) {
            // Prior turns' messages belong to prior worklogs.
            if (m.info?.id && preTurnMessages.has(m.info.id)) continue;
            for (const part of m.parts ?? []) {
              if (part.type === "tool" || part.type === "subtask") await enqueuePart(part);
            }
          }
        } catch {
          /* history is a safety net — a failed fetch just leaves the live log as-is */
        }
      };
      // Enumerate subagent sessions the pump may have missed, then reconcile the
      // parent first (its `task`/tool steps) followed by each child (↳ tools).
      try {
        const cres = await fetch(`${baseUrl}/session/${sessionId}/children${dirQ}`, { headers, signal: ctx.signal });
        if (cres.ok) {
          for (const c of (await cres.json()) as { id?: string }[]) {
            if (c.id && !preTurnChildren.has(c.id)) childSessions.add(c.id);
          }
        }
      } catch {
        /* best-effort child discovery */
      }
      await reconcileSession(sessionId, false);
      for (const cid of [...childSessions]) if (cid !== sessionId) await reconcileSession(cid, true);

      const replyTexts = (reply.parts ?? [])
        .filter((p) => p.type === "text" && p.text?.trim())
        .map((p) => p.text as string);
      const finalTexts = replyTexts.length > 0 ? replyTexts : [...textParts.values()].filter((t) => t.trim());
      for (const t of finalTexts) {
        await ctx.emit({ kind: "task", label: truncate(t, 60), chip: "task" });
      }
      await ctx.emit({ kind: "done", label: "Done", chip: null });
      ctx.setSummary(
        finalTexts[finalTexts.length - 1]?.trim() || "opencode run completed",
        Date.now() - startedAt,
      );
    } finally {
      // A thread's sandbox is the conversation's world (workspace + resident
      // server + sessions) — a failed TURN must not destroy it. Only runs
      // without a thread clean up their box.
      if (sandbox && (!ctx.threadId || !persistedForThread)) {
        await sandbox.delete().catch(() => {});
      }
    }
  },
};
