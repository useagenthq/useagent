import { Daytona, type Sandbox } from "@daytona/sdk";
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
import { toolGatewayConfig } from "../knowledge/gateway/config";
import { ACP_COMMANDS_EVENT_TYPE, SESSION_STARTED_EVENT_TYPE } from "@skynet/agent-harness/canonical";
import { sessionCapabilities } from "./capabilities";
import { mintToolToken } from "../knowledge/gateway/token";
import { MEMORY_SKILL_PATH, memorySkillText } from "../memory/memory-skill-text";
import { composeSecretEnv, materializeSecretFiles } from "../secrets/inject";

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

const DEFAULT_MODEL = "claude-opus-5";
const SERVE_PORT = 4096;
const OPENCODE_VERSION = "1.18.7";

/** Per-thread live server: sandbox + resolved preview endpoint. In-memory (a
 *  backend restart re-resolves); sandbox auto-stop/auto-delete contain cost. */
interface ThreadServer {
  sandboxId: string;
  baseUrl: string;
  token: string;
}
const threadServers = new Map<string, ThreadServer>();

export function getOpencodeThreadSandboxId(threadId: string): string | null {
  return threadServers.get(threadId)?.sandboxId ?? null;
}

function authHeaders(token: string): Record<string, string> {
  return { "x-daytona-preview-token": token };
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
 *  Every probe curl carries `-m 2` — an accepting-but-slow server must fail the
 *  PROBE, not hang the whole exec into a Daytona 408 (observed live). Any HTTP
 *  status (even 404) means the server is up. */
async function ensureServer(
  sandbox: Sandbox,
  npx: boolean,
): Promise<{ baseUrl: string; token: string; workdir: string }> {
  const bin = npx ? `npx -y opencode-ai@${OPENCODE_VERSION}` : "opencode";
  const probe = `curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:${SERVE_PORT}/`;
  const boot = await sandbox.process.executeCommand(
    `mkdir -p ~/work; ` +
      `if [ "$(${probe})" = "000" ]; then ` +
      `cd ~/work && nohup ${bin} serve --hostname 0.0.0.0 --port ${SERVE_PORT} > /tmp/opencode-serve.log 2>&1 & ` +
      `fi; ` +
      `up=0; for i in $(seq 1 45); do ` +
      `[ "$(${probe})" != "000" ] && up=1 && break; sleep 1; done; ` +
      `if [ "$up" = "1" ]; then echo "HOME=$HOME"; exit 0; fi; ` +
      `echo BOOT-TIMEOUT; tail -c 400 /tmp/opencode-serve.log; exit 1`,
    undefined,
    undefined,
    150,
  );
  if ((boot.exitCode ?? 1) !== 0) {
    throw new Error(`opencode serve failed to boot: ${truncate(boot.result ?? "", 200)}`);
  }
  const home = /HOME=(\S+)/.exec(boot.result ?? "")?.[1] ?? "/home/daytona";
  const link = await sandbox.getPreviewLink(SERVE_PORT);
  return { baseUrl: link.url.replace(/\/+$/, ""), token: link.token ?? "", workdir: `${home}/work` };
}

// shq / repo cloning live in the shared engine-neutral ./repo-prep (imported above).

/**
 * Inject the Skynet knowledge MCP server into the sandbox's opencode config so
 * the resident agent can call `knowledge_search`/`knowledge_read` (mem_op.md 0.2).
 *
 * TRUST BOUNDARY: the ONLY thing that enters the untrusted sandbox is a
 * short-lived, run-scoped bearer TOKEN — never DB/embedding/tenant credentials.
 * The gateway derives org/user/thread from that token server-side. We write the
 * MCP entry into opencode's GLOBAL config (`~/.config/opencode/opencode.json`)
 * — merged with any snapshot config, immune to a repo clone into the workspace,
 * and loaded at `opencode serve` boot — so this MUST run BEFORE {@link ensureServer}.
 *
 * Gated: a no-op unless TOOL_GATEWAY_PUBLIC_URL is set (the sandbox-reachable
 * backend origin) AND the run carries an org identity. Best-effort — a config
 * write failure logs and continues; the run just runs without knowledge tools.
 *
 * KNOWN LIMITATION: a WARM resumed thread already has `opencode serve` running
 * with the prior turn's token baked into its MCP client, so a freshly written
 * token is not hot-reloaded until the sandbox restarts. The prior token is the
 * same org/thread and within TTL, so authorization is unchanged; only rotation
 * lags. Fresh sandboxes (the common case) always get the current token.
 */
async function ensureKnowledgeGatewayConfig(sandbox: Sandbox, ctx: EngineRunContext): Promise<boolean> {
  const gw = toolGatewayConfig();
  if (!gw || !ctx.orgId) return false; // gateway not wired, or run has no org identity → fail closed (no tools)
  try {
    const token = mintToolToken(
      {
        orgId: ctx.orgId,
        userId: ctx.userId ?? "",
        threadId: ctx.threadId ?? ctx.runId,
        runId: ctx.runId,
      },
      gw.tokenTtlMs,
    );
    // Merge into any existing global config so snapshot-provided settings (models,
    // allowlists) survive. Read-parse-merge in TS (a shell JSON merge is brittle).
    const read = await sandbox.process
      .executeCommand("cat ~/.config/opencode/opencode.json 2>/dev/null || true", undefined, undefined, 10)
      .catch(() => null);
    let cfg: Record<string, unknown> = {};
    const existing = (read?.result ?? "").trim();
    if (existing) {
      try {
        cfg = JSON.parse(existing) as Record<string, unknown>;
      } catch {
        cfg = {}; // unparseable → start clean rather than fail the run
      }
    }
    cfg["$schema"] = cfg["$schema"] ?? "https://opencode.ai/config.json";
    const mcp = (typeof cfg.mcp === "object" && cfg.mcp ? (cfg.mcp as Record<string, unknown>) : {});
    mcp["skynet-knowledge"] = {
      type: "remote",
      url: gw.mcpUrl,
      enabled: true,
      headers: { Authorization: `Bearer ${token}` },
    };
    cfg.mcp = mcp;
    // base64 avoids every shell-escaping hazard (the token/URL never touch argv
    // unencoded, so they are not in `ps` or logs inside the box). Write BOTH the
    // GLOBAL config (`~/.config/opencode/opencode.json`, loaded at serve boot for
    // every session) AND the PROJECT config (`~/work/opencode.json`, loaded when a
    // session scoped to ~/work resolves its project) — opencode merges them, so
    // the same MCP entry in both is robust to either resolution path.
    const b64 = Buffer.from(JSON.stringify(cfg), "utf8").toString("base64");
    await sandbox.process.executeCommand(
      `mkdir -p ~/.config/opencode ~/work && printf %s '${b64}' | base64 -d | tee ~/.config/opencode/opencode.json > ~/work/opencode.json`,
      undefined,
      undefined,
      15,
    );
    console.log(`[opencode] knowledge MCP gateway wired for run ${ctx.runId} (org ${ctx.orgId})`);
    return true;
  } catch (e) {
    console.warn(`[opencode] knowledge gateway config write failed (continuing without tools):`, (e as Error).message);
    return false;
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
async function correctMemorySkillText(sandbox: Sandbox, hasTools: boolean): Promise<void> {
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
  info?: { id?: string; role?: string; time?: { created?: number; completed?: number } };
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
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) return null;
  try {
    const daytona = new Daytona({ apiKey, target: process.env.DAYTONA_TARGET ?? "us" });
    const sandbox = await daytona.get(sandboxId).catch(() => null);
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
    const apiKey = process.env.DAYTONA_API_KEY;
    if (!apiKey) throw new Error("opencode engine needs DAYTONA_API_KEY in the backend env");
    const startedAt = Date.now();
    const daytona = new Daytona({ apiKey, target: process.env.DAYTONA_TARGET ?? "us" });
    const budgetMs = Number(process.env.ENGINE_TIMEOUT_MS ?? 600_000);

    // Org secrets ride in via a BASH_ENV dotenv (createEnv), NOT as N env vars —
    // Daytona rejects a create with a whole 400+ secret catalog. Platform engine
    // keys are added after and win on name. composeSecretEnv also records the
    // names-only `secrets.injected` marker; the dotenv + file-kind secrets are
    // written into the sandbox after boot below.
    const secretInjection = await composeSecretEnv(ctx);
    const envVars: Record<string, string> = { ...secretInjection.createEnv };
    if (process.env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (process.env.OPENROUTER_API_KEY) envVars.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

    const snapshot = process.env.DAYTONA_SNAPSHOT ?? "skynet-agent-v17";
    let sandbox: Sandbox | null = null;
    let npxFallback = false;
    let retainForThread = false;
    let succeeded = false;

    try {
      // ── sandbox: reuse the thread's (memory cache → durable DB mapping) ─────
      const rememberedId =
        (ctx.threadId ? threadServers.get(ctx.threadId)?.sandboxId : undefined) ??
        (ctx.threadId ? await getThreadSandbox(ctx.threadId) : null);
      if (rememberedId) {
        try {
          const prior = await daytona.get(rememberedId);
          const state = (prior as { state?: string }).state;
          if (state === "stopped" || state === "paused" || state === "archived") {
            await ctx.emit({ kind: "task", label: `Resuming thread sandbox ${prior.id.slice(0, 8)}…`, chip: "opencode" });
            await prior.start();
          } else if (state !== "started") {
            throw new Error(`unusable state: ${state}`);
          }
          sandbox = prior;
          retainForThread = true;
        } catch {
          if (ctx.threadId) threadServers.delete(ctx.threadId);
          sandbox = null;
        }
      }
      // Stop quickly (a stopped sandbox keeps its disk at ~zero cost and
      // restarts in seconds; ensureServer re-boots `opencode serve` on wake),
      // but keep the thread's world alive for DAYS before deletion.
      const autoStopInterval = Number(process.env.SANDBOX_AUTO_STOP_MIN ?? 30);
      const autoDeleteInterval = Number(process.env.SANDBOX_AUTO_DELETE_MIN ?? 4320); // 3 days
      if (!sandbox) {
        await ctx.emit({ kind: "task", label: "Provisioning cloud sandbox…", chip: "opencode" });
        try {
          sandbox = await daytona.create({
            snapshot,
            envVars,
            labels: { "skynet-run": ctx.runId },
            autoStopInterval,
            autoDeleteInterval,
          });
        } catch {
          sandbox = await daytona.create({
            envVars,
            labels: { "skynet-run": ctx.runId },
            autoStopInterval,
            autoDeleteInterval,
          });
          npxFallback = true;
        }
        await ctx.emit({
          kind: "task",
          label: `Sandbox ${sandbox.id.slice(0, 8)} ready in ${Math.round((Date.now() - startedAt) / 1000)}s`,
          chip: "opencode",
        });
      }
      if (ctx.signal.aborted) throw new Error("opencode run aborted (timeout)");

      // Durable thread→sandbox mapping BEFORE we boot the server / run tools: the DB row
      // survives restarts (the in-memory map is just a preview cache). AWAITED + FAIL-CLOSED
      // (same invariant as ACP): if the association cannot be recorded we abort the turn
      // rather than run in a box the terminal/preview/file/cleanup routes can't resolve, and
      // a box we JUST provisioned is torn down (a reused resident box is kept for the thread).
      const box = sandbox;
      await persistSandboxBeforeExecution({
        runId: ctx.runId,
        sandboxId: box.id,
        reused: retainForThread,
        persist: setRunSandbox,
        deleteFreshSandbox: () => box.delete(),
      });

      // Inject the knowledge MCP gateway (run-scoped token only) into the global
      // opencode config BEFORE booting the server, so the resident agent picks up
      // knowledge_search/knowledge_read at `opencode serve` start. Gated + best-effort.
      const toolsWired = await ensureKnowledgeGatewayConfig(sandbox, ctx);

      // Replace the snapshot's false-persistence memory skill BEFORE the server
      // boots (new_mem_prompt.md 7), with text that MATCHES reality: tools-based
      // when the gateway is wired, else an explicit "no durable memory tools; do
      // not claim a save or write local files" (the observed no-gateway lie).
      await correctMemorySkillText(sandbox, toolsWired);

      // Materialize any file-kind org secrets (0600) before the agent turn, so a
      // path env var (e.g. GOOGLE_APPLICATION_CREDENTIALS) points at a real file.
      await materializeSecretFiles(
        (cmd) => sandbox!.process.executeCommand(cmd, undefined, undefined, 30),
        secretInjection.files,
      );

      // ── persistent server + preview endpoint ────────────────────────────────
      const { baseUrl, token, workdir } = await ensureServer(sandbox, npxFallback);
      if (ctx.threadId) {
        threadServers.set(ctx.threadId, { sandboxId: sandbox.id, baseUrl, token });
        retainForThread = true;
      }
      const headers = { ...authHeaders(token), "content-type": "application/json" };
      const dirQ = `?directory=${encodeURIComponent(workdir)}`;

      // Clone EACH selected repo into its own workspace subdir before the turn,
      // via the shared engine-neutral preparer (idempotent per repo; a resumed
      // thread already has them, so fast skips). A fresh clone that fails fails
      // the run honestly, before the engine works without the repo.
      await prepareRepos(sandbox, workdir, ctx);

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

      // session.started with the ONE negotiated capability map (Phase 6). OpenCode has the native
      // web embed (Live) and the v17 snapshot ships noVNC (desktop), so both are true; knowledgeTools
      // reflects whether the tool gateway is actually configured/reachable.
      void recordProviderEvent({
        id: `${ctx.runId}:${sessionId}:session`,
        runId: ctx.runId,
        threadId: ctx.threadId ?? ctx.runId,
        provider: "opencode",
        eventType: SESSION_STARTED_EVENT_TYPE,
        nativeSessionId: sessionId,
        payload: {
          source: "opencode",
          capabilities: sessionCapabilities("opencode", { desktop: true, knowledgeTools: toolGatewayConfig() !== null }),
        },
      });

      // C5/D3: capture OpenCode's native `/command` list into the SAME per-session `acp.commands`
      // provider event the ACP engines write, so the translator emits a durable `commands.updated`
      // for opencode too (ONE authoritative session-command lane; the snapshot cache is UI priming).
      // AWAITED here - BEFORE the prompt is sent - so the catalog is durably persisted before the
      // turn can seal (no fire-and-forget race with drainProviderEvents). An EMPTY list is a genuine
      // "advertises none" REPLACEMENT and IS persisted (distinct from "not advertised yet"). Bounded
      // (8s) + best-effort: a slow/failed /command never stalls the turn; with no durable catalog,
      // command authorization simply fails closed (C3/C4).
      if (!ctx.signal.aborted) {
        try {
          const res = await fetch(`${baseUrl}/command${dirQ}`, { headers: authHeaders(token), signal: AbortSignal.timeout(8000) });
          const parsed = res.ok ? await res.json().catch(() => null) : null;
          if (Array.isArray(parsed)) {
            const frame = {
              id: `${ctx.runId}:${sessionId}:commands`,
              runId: ctx.runId,
              threadId: ctx.threadId ?? ctx.runId,
              provider: "opencode",
              eventType: ACP_COMMANDS_EVENT_TYPE,
              nativeSessionId: sessionId,
              payload: { source: "opencode", commands: parsed, ts: Date.now() }, // parsed may be [] - persisted
            };
            for (let a = 0; a < 3; a++) {
              await recordProviderEvent(frame, { critical: true });
              if (await providerEventExists(frame.id)) break;
              if (a < 2) await new Promise((r) => setTimeout(r, 100 * (a + 1)));
            }
          }
        } catch {
          /* best-effort: a slow/failed /command never blocks opencode chat (fail-closed command auth) */
        }
      }

      // ── realtime: subscribe /event BEFORE prompting ─────────────────────────
      const sseAbort = new AbortController();
      const onParentAbort = () => sseAbort.abort();
      ctx.signal.addEventListener("abort", onParentAbort, { once: true });

      // Live translation state: text deltas by part id; tool steps by part id.
      // Subagents run in CHILD sessions (parentID chains to ours) — track them so
      // their tool activity renders (↳-tagged) instead of being filtered out.
      const childSessions = new Set<string>();
      const textLen = new Map<string, number>();
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
          payload: part,
        });
      };
      const enqueuePart = (part: Record<string, unknown>, delta?: string): Promise<void> => {
        capturePart(part);
        partChain = partChain.then(() => handlePart(part, delta)).catch(() => {});
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
            const props = ((ev.properties ?? ev.data) ?? {}) as {
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

      let reply: { parts?: { type?: string; text?: string }[] };
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
            return { parts: (last?.parts ?? []) as { type?: string; text?: string }[] };
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
      try {
        let res = await postOrPoll(composeTurnPrompt(ctx, resumed));
        if (res && res.status === 404 && resumed) {
          // Stale resume id (session from a previous sandbox/server incarnation)
          // — start fresh WITH the full bootstrap + per-turn context.
          sessionId = await createSession();
          resumed = false;
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
      }

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
      succeeded = true;
    } finally {
      // A thread's sandbox is the conversation's world (workspace + resident
      // server + sessions) — a failed TURN must not destroy it. Only runs
      // without a thread clean up their box.
      if (sandbox && !ctx.threadId) {
        await sandbox.delete().catch(() => {});
      }
    }
  },
};
