import { Daytona, type Sandbox } from "@daytona/sdk";
import type { EmitStep, EngineAdapter, EngineRunContext } from "./types";
import { composeTurnPrompt } from "./types";
import { basename, parseJsonLine, persistSandboxBeforeExecution, truncate } from "./util";
import { buildSessionCancel, createAcpRpcClient, isAlreadyInitialized, relayStateAfterBoot } from "./acp-rpc";
import { allowPermissionBypass, decideAcpPermission } from "./permission-policy";
import { toolGatewayConfig } from "../knowledge/gateway/config";
import { mintToolToken } from "../knowledge/gateway/token";
import { composeSecretEnv, materializeSecretFiles } from "../secrets/inject";
import { getThreadSandbox, setRunSandbox } from "../runs/repo";

// ---------------------------------------------------------------------------
// Resident claude/codex via ACP — the opencode-server equivalent for the other
// two engines. Each thread sandbox runs a PERSISTENT ACP agent (claude:
// @agentclientprotocol/claude-agent-acp holding Claude Agent SDK sessions in
// memory; codex: @agentclientprotocol/codex-acp wrapping codex's server) behind
// a tiny dependency-free HTTP relay (POST /send → agent stdin, GET /events SSE
// ← agent stdout), reached through the sandbox preview link. One session per
// conversation (`session/new` once, `session/prompt` per turn) — engine boot
// cost is paid once per sandbox; a turn is one JSON-RPC request with streamed
// `session/update` events translated live into steps + deltas.
// ---------------------------------------------------------------------------

const CLAUDE_ACP_PKG = "@agentclientprotocol/claude-agent-acp@0.64.2";
// codex-acp@0.16.0 does not exist under this namespace (that version belongs to
// @zed-industries/codex-acp) - the 404 silently no-op'd the install so `codex-acp` never
// landed and the relay's child spawn failed (BOOT-TIMEOUT). The real package is 1.1.x and
// bundles @openai/codex (the `codex` binary) as a dependency, so installing it provisions
// codex too (#128).
const CODEX_ACP_PKG = "@agentclientprotocol/codex-acp@1.1.14";
const CLAUDE_CODE_PKG = "@anthropic-ai/claude-code@2.1.222";

/** The in-sandbox relay: stdin/stdout bridge to the ACP agent over plain HTTP
 *  (SSE out, POST in) — WebSockets are unnecessary and unproven through the
 *  preview proxy, SSE is proven (opencode /event). Node built-ins only. */
const RELAY_SCRIPT = `
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const PORT = Number(process.argv[2]);
const CMD = process.argv[3];
const ARGS = process.argv.slice(4);
let child = null;
const clients = new Set();
function boot() {
  let buf = "";
  child = spawn(CMD, ARGS, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) for (const res of clients) res.write("data: " + line + "\\n\\n");
    }
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.on("exit", () => setTimeout(boot, 1000)); // agent died → respawn, sessions restart fresh
}
boot();
createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (req.url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    res.write(":ok\\n\\n");
    clients.add(res);
    const hb = setInterval(() => res.write(":hb\\n\\n"), 15000);
    req.on("close", () => { clearInterval(hb); clients.delete(res); });
    return;
  }
  if (req.method === "POST" && req.url === "/send") {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { child.stdin.write(b.trim() + "\\n"); res.writeHead(204); res.end(); }
      catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, "0.0.0.0");
`;

export interface AcpEngineConfig {
  id: "claude" | "codex";
  port: number;
  /** npm packages installed once per sandbox (user prefix); `bin` is the
   *  installed binary probed for idempotency (differs from the package name). */
  packages: { pkg: string; bin: string }[];
  /** Relay child command (resolved on the sandbox PATH incl. ~/.local/bin). */
  agentCmd: string[];
  /** Extra env exported before the relay starts. */
  agentEnv?: Record<string, string>;
  /** A shell snippet run once per relay boot AFTER the package install (so the agent bin
   *  is on PATH) and BEFORE the relay starts. Codex uses it to seed auth. Idempotent. */
  preRelay?: string;
  /** Idempotent per-turn sandbox prep (codex auth seeding). */
  prepare?(sandbox: Sandbox): Promise<void>;
}

/** Total wall-clock budget for ONE ACP turn (drives the turn-abort timer). A fresh
 *  Claude/Codex sandbox reinstalls the agent (~250MB) AND runs the turn's first tool, which
 *  routinely exceeds the old 180s default and aborted real cold runs; the committed default
 *  is now 360s so a cold first turn is reliable without runtime-only ENV tweaks. Precedence:
 *    1. ACP_TURN_TIMEOUT_MS  (ACP-specific boundary)
 *    2. ENGINE_TIMEOUT_MS    (shared, kept for back-compat)
 *    3. 360_000              (safe default)
 *  Each candidate must parse to a FINITE POSITIVE number WITHIN the safe maximum or it is
 *  ignored - an invalid / NaN / zero / non-finite value, AND any value above the safe max,
 *  can never create a zero, NaN or (via setTimeout's 32-bit clamp) an effectively-immediate
 *  1ms timer. This does NOT touch OpenCode's own budget (opencode-server keeps its 600s
 *  default) or the worker's sliding inactivity window / absolute ceiling. Exported for
 *  focused tests. */
// Documented safe maximum: the largest delay Node/Bun's setTimeout accepts before it
// overflows a signed 32-bit int and CLAMPS the delay to 1ms (firing almost immediately).
// The worker's absolute ceiling (ENGINE_MAX_MS, default 4h = 14_400_000ms) sits far below
// this, so every realistic turn budget passes; only pathological values are rejected.
const MAX_TURN_TIMEOUT_MS = 2_147_483_647; // 2^31 - 1
export function resolveAcpTurnTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const DEFAULT_MS = 360_000;
  const valid = (raw: string | undefined): number | null => {
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n <= MAX_TURN_TIMEOUT_MS ? n : null;
  };
  return valid(env.ACP_TURN_TIMEOUT_MS) ?? valid(env.ENGINE_TIMEOUT_MS) ?? DEFAULT_MS;
}

/** Build the per-sandbox package install clause. Idempotency MUST key on the ACTUAL
 *  install path (~/.local/bin/<bin>), NOT `command -v <bin>` - a <bin> that resolves
 *  elsewhere on PATH (the base image ships `claude`) would skip the install, and the
 *  exact path CLAUDE_CODE_EXECUTABLE points at (~/.local/bin/claude) would never get
 *  created (#127). Exported so the regression test can assert this without a sandbox. */
export function buildAcpInstallClause(packages: { pkg: string; bin: string }[]): string {
  return packages
    .map(
      ({ pkg, bin }) =>
        `[ -x "$HOME/.local/bin/${bin}" ] || npm install -g --prefix $HOME/.local --silent "${pkg}" >/dev/null 2>&1; `,
    )
    .join("");
}

interface ThreadRelay {
  sandboxId: string;
  baseUrl: string;
  token: string;
  workdir: string;
  /** ACP session id LIVE in the current agent process (also persisted to the
   *  DB; a dead process/sandbox invalidates it and we session/new again). */
  sessionId: string | null;
  /** Whether the CURRENT resident agent process/generation has been ACP-`initialize`d.
   *  ACP `initialize` is once per connection lifetime; a resident agent reused across
   *  turns is already initialized and codex-acp rejects a re-`initialize` with -32603
   *  "Already initialized". Reset to false when the relay/agent (re)starts. */
  initialized: boolean;
}

/** threadId → per-engine relay state (a thread talks to ONE engine's relay). */
const threadRelays = new Map<string, ThreadRelay>();

const relayKey = (threadId: string, engine: string): string => `${engine}:${threadId}`;

function authHeaders(token: string): Record<string, string> {
  return { "x-daytona-preview-token": token };
}

/** Best-effort native ACP cancel: POST a `session/cancel` notification to the relay
 *  so the agent stops the ongoing turn (ACP v1: it replies to the in-flight
 *  session/prompt with stopReason "cancelled") instead of continuing server-side after
 *  we drop the SSE. Own short-lived controller (NOT the run's sseAbort, which we are
 *  about to fire) and swallowed errors: if the relay is already gone, closing the SSE
 *  still ends the turn. Fire-and-forget. */
async function sendSessionCancel(baseUrl: string, token: string, sessionId: string): Promise<void> {
  const ac = new AbortController();
  const budget = setTimeout(() => ac.abort(), 5_000);
  try {
    await fetch(`${baseUrl}/send`, {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(buildSessionCancel(sessionId)),
      signal: ac.signal,
    });
  } catch {
    /* best-effort - the SSE close below still ends the turn */
  } finally {
    clearTimeout(budget);
  }
}

/**
 * Build the ACP `mcpServers` array carrying the Skynet knowledge gateway — the
 * ACP-native equivalent of opencode's ensureKnowledgeGatewayConfig. Passed into
 * BOTH session/new and session/load so a fresh AND a resumed ACP session can call
 * knowledge_search / knowledge_read, at parity with opencode.
 *
 * TRUST BOUNDARY (identical to opencode): the ONLY thing that enters the
 * untrusted sandbox is a short-lived, run-scoped bearer TOKEN over HTTP — never
 * DB/embedding/tenant credentials. The gateway derives org/user/thread from the
 * token server-side. Same URL, TTL, and minted identity as the opencode path.
 *
 * Gated: empty unless TOOL_GATEWAY_PUBLIC_URL is set AND the run has an org
 * identity (fail closed — no tools rather than an unscoped one). Off by default,
 * so existing ACP runs are byte-for-byte unchanged.
 *
 * Shape: the ACP HTTP MCP-server descriptor `{ type:"http", name, url, headers }`.
 * NOTE: unverified against a LIVE claude/codex ACP agent (engines are disabled);
 * the contract test asserts the config carries the entry + a valid token.
 */
export function acpKnowledgeMcpServers(ctx: EngineRunContext): Record<string, unknown>[] {
  const gw = toolGatewayConfig();
  if (!gw || !ctx.orgId) return [];
  const token = mintToolToken(
    {
      orgId: ctx.orgId,
      userId: ctx.userId ?? "",
      threadId: ctx.threadId ?? ctx.runId,
      runId: ctx.runId,
    },
    gw.tokenTtlMs,
  );
  return [
    {
      type: "http",
      name: "skynet-knowledge",
      url: gw.mcpUrl,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    },
  ];
}

// ── ACP session/update → step/delta translation ─────────────────────────────

const ACP_FILE_KINDS = new Set(["edit", "delete", "move", "read"]);

function acpToolStep(
  update: Record<string, unknown>,
  output: string | undefined,
): EmitStep {
  const kind = String(update.kind ?? "other");
  const title = String(update.title ?? kind);
  const rawInput = (update.rawInput ?? {}) as Record<string, unknown>;
  const path = String(rawInput.file_path ?? rawInput.path ?? rawInput.abs_path ?? "");
  const isFile = ACP_FILE_KINDS.has(kind) && kind !== "read";
  const label =
    kind === "execute"
      ? truncate(String(rawInput.command ?? title))
      : path
        ? isFile
          ? basename(path)
          : `${title.split(" ")[0]} ${basename(path)}`
        : truncate(title, 60);
  return {
    kind: isFile ? "file" : kind === "task" ? "task" : "command",
    label,
    chip: kind === "execute" ? "bash" : kind === "task" ? "subagent" : isFile ? "file" : kind,
    code_json: {
      tool: kind,
      title,
      input: rawInput,
      ...(output !== undefined ? { output: output.slice(0, 2000) } : {}),
    },
  };
}

/** Flatten a tool_call_update's content blocks to text. */
function acpContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      const inner = (c as { content?: { text?: string } }).content;
      return typeof inner?.text === "string" ? inner.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

// ── the adapter ─────────────────────────────────────────────────────────────

function makeAcpAdapter(cfg: AcpEngineConfig): EngineAdapter {
  return {
    id: cfg.id,

    async run(ctx: EngineRunContext): Promise<void> {
      const apiKey = process.env.DAYTONA_API_KEY;
      if (!apiKey) throw new Error(`${cfg.id} engine needs DAYTONA_API_KEY in the backend env`);
      const startedAt = Date.now();
      const daytona = new Daytona({ apiKey, target: process.env.DAYTONA_TARGET ?? "us" });
      const budgetMs = resolveAcpTurnTimeoutMs();

      // Org secrets ride in via a BASH_ENV dotenv (createEnv), not as N env vars
      // (Daytona rejects a create with a whole secret catalog). Platform engine
      // keys are added after and win on name. composeSecretEnv also records the
      // `secrets.injected` marker (names only); the dotenv + file-kind secrets are
      // written after the sandbox is up (below).
      const secretInjection = await composeSecretEnv(ctx);
      const envVars: Record<string, string> = { ...secretInjection.createEnv };
      // Credentials (final_harness.md P0): per-tenant creds arrive via org secrets
      // (composeSecretEnv above) - the SaaS-safe path that works in prod. The
      // platform's broad ANTHROPIC_API_KEY is injected ONLY in verified-dev yolo
      // (allowPermissionBypass) so a developer can exercise claude/codex ACP locally
      // without provisioning a secret; production NEVER receives it. Longer term the
      // trusted provider gateway (#121) replaces even the dev injection.
      if (allowPermissionBypass() && process.env.ANTHROPIC_API_KEY) {
        envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      }
      // Codex parallel: the codex-acp NODE process reads OPENAI_API_KEY from its own env at
      // launch, not from the bash-sourced org-secret dotenv (that only reaches the agent's
      // bash TOOL commands, and lands under a home the ACP process may not read). So in
      // verified-dev yolo, inject it as a DIRECT sandbox env var - same escape hatch as
      // ANTHROPIC above. Production still relies on the org secret via the trusted gateway
      // (#121); this dev key is NEVER injected outside yolo.
      if (allowPermissionBypass() && process.env.OPENAI_API_KEY) {
        envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      }

      const autoStopInterval = Number(process.env.SANDBOX_AUTO_STOP_MIN ?? 30);
      const autoDeleteInterval = Number(process.env.SANDBOX_AUTO_DELETE_MIN ?? 4320);

      const key = ctx.threadId ? relayKey(ctx.threadId, cfg.id) : null;
      let relay = key ? threadRelays.get(key) : undefined;
      let sandbox: Sandbox | null = null;
      let retainForThread = false;
      let succeeded = false;

      try {
        // ── sandbox: reuse the thread's, else provision ─────────────────────
        if (relay) {
          try {
            const prior = await daytona.get(relay.sandboxId);
            const state = (prior as { state?: string }).state;
            if (state === "stopped" || state === "paused" || state === "archived") {
              await ctx.emit({ kind: "task", label: `Resuming thread sandbox ${prior.id.slice(0, 8)}…`, chip: cfg.id });
              await prior.start();
              relay.sessionId = null; // agent process died with the stop
            } else if (state !== "started") {
              throw new Error(`unusable state: ${state}`);
            }
            sandbox = prior;
            retainForThread = true;
          } catch {
            if (key) threadRelays.delete(key);
            relay = undefined;
            sandbox = null;
          }
        }
        // Durable reuse across a BACKEND restart: no in-memory relay, but the thread
        // recorded a sandbox (setRunSandbox below). Reconnect to it instead of
        // provisioning a new one; the boot step re-probes/restarts the resident relay.
        // A dead/unreachable persisted sandbox is NEVER trusted - fall through to fresh.
        if (!sandbox && ctx.threadId) {
          const priorId = await getThreadSandbox(ctx.threadId).catch(() => null);
          if (priorId) {
            try {
              const prior = await daytona.get(priorId);
              const state = (prior as { state?: string }).state;
              if (state === "stopped" || state === "paused" || state === "archived") {
                await ctx.emit({ kind: "task", label: `Resuming thread sandbox ${prior.id.slice(0, 8)}…`, chip: cfg.id });
                await prior.start();
              } else if (state !== "started") {
                throw new Error(`unusable state: ${state}`);
              }
              sandbox = prior;
              retainForThread = true;
            } catch {
              sandbox = null; // persisted sandbox is gone/unusable — provision fresh
            }
          }
        }
        if (!sandbox) {
          await ctx.emit({ kind: "task", label: "Provisioning cloud sandbox…", chip: cfg.id });
          sandbox = await daytona.create({
            envVars,
            labels: { "skynet-run": ctx.runId },
            autoStopInterval,
            autoDeleteInterval,
          });
          await ctx.emit({
            kind: "task",
            label: `Sandbox ${sandbox.id.slice(0, 8)} ready in ${Math.round((Date.now() - startedAt) / 1000)}s`,
            chip: cfg.id,
          });
        }
        if (ctx.signal.aborted) throw new Error(`${cfg.id} run aborted (timeout)`);
        const box = sandbox;
        // Persist the sandbox id for THIS run (durable thread->sandbox mapping) BEFORE we
        // prepare/boot/execute, so the UI terminal/preview/file lookups, cleanup and
        // recovery can resolve it (ACP used to leave runs.sandbox_id NULL). AWAITED +
        // FAIL-CLOSED: if the association cannot be recorded we abort the turn rather than
        // run in a box the control plane can't see, and a box we JUST provisioned is torn
        // down (a reused resident box is kept for the thread lifecycle below).
        try {
          await persistSandboxBeforeExecution({
            runId: ctx.runId,
            sandboxId: box.id,
            reused: retainForThread,
            persist: setRunSandbox,
            deleteFreshSandbox: () => box.delete(),
          });
        } catch (err) {
          // The helper already tore down a FRESHLY provisioned box; clear the ref so the
          // run's finally (which also deletes on !succeeded) does not delete it a SECOND
          // time. A reused resident box was NOT touched by the helper - leave `sandbox` set
          // so its existing (unchanged) finally lifecycle still applies.
          if (!retainForThread) sandbox = null;
          throw err;
        }

        await cfg.prepare?.(box);

        // Materialize any file-kind org secrets (0600) before the agent turn.
        await materializeSecretFiles(
          (cmd) => box.process.executeCommand(cmd, undefined, undefined, 30),
          secretInjection.files,
        );

        // ── resident agent: install once, relay up, resolve endpoint ────────
        const probeCmd = `curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:${cfg.port}/health`;
        const relayB64 = Buffer.from(RELAY_SCRIPT, "utf8").toString("base64");
        const agentEnvExports = Object.entries(cfg.agentEnv ?? {})
          .map(([k, v]) => `export ${k}="${v}"; `)
          .join("");
        const boot = await box.process.executeCommand(
          `export PATH=$HOME/.local/bin:$PATH; mkdir -p ~/work; ` +
            // Install the agent package(s) once per sandbox (path-keyed idempotency).
            buildAcpInstallClause(cfg.packages) +
            // Stage the relay + start it if not already answering.
            `printf '%s' '${relayB64}' | base64 -d > ~/acp-relay.mjs; ` +
            // `booted=1` ONLY when we actually (re)start the relay this call - i.e. the
            // health probe found no live relay. A restart means a FRESH agent process,
            // so any in-memory native session id from a prior turn is now stale.
            `booted=0; if [ "$(${probeCmd})" = "000" ]; then booted=1; ` +
            // Per-engine pre-relay step, AFTER install so the agent bin is on PATH. Codex
            // uses it to seed auth (`codex login --with-api-key` -> ~/.codex/auth.json):
            // codex-acp requires the logged-in state, not just the OPENAI_API_KEY env.
            (cfg.preRelay ?? "") +
            `${agentEnvExports}cd ~/work && nohup node ~/acp-relay.mjs ${cfg.port} ${cfg.agentCmd.join(" ")} > /tmp/acp-relay-${cfg.id}.log 2>&1 & ` +
            `fi; ` +
            `up=0; for i in $(seq 1 30); do [ "$(${probeCmd})" != "000" ] && up=1 && break; sleep 1; done; ` +
            `if [ "$up" = "1" ]; then echo "HOME=$HOME BOOTED=$booted"; exit 0; fi; ` +
            `echo BOOT-TIMEOUT; tail -c 400 /tmp/acp-relay-${cfg.id}.log; exit 1`,
          undefined,
          undefined,
          300,
        );
        if ((boot.exitCode ?? 1) !== 0) {
          throw new Error(`${cfg.id} ACP relay failed to boot: ${truncate(boot.result ?? "", 200)}`);
        }
        const home = /HOME=(\S+)/.exec(boot.result ?? "")?.[1] ?? "/home/daytona";
        // A relay (re)boot this call means a fresh agent process - the previous turn's
        // in-memory native session id is dead. Invalidate it below so we session/load
        // (persisted id) or session/new instead of prompting a stale session.
        const relayRebooted = / BOOTED=1/.test(boot.result ?? "");

        if (!relay) {
          const link = await box.getPreviewLink(cfg.port);
          relay = {
            sandboxId: box.id,
            baseUrl: link.url.replace(/\/+$/, ""),
            token: link.token ?? "",
            workdir: `${home}/work`,
            sessionId: null,
            initialized: false,
          };
        }
        const live = relay; // narrowed non-null for the closures below
        // Restart-generation state machine (single source of truth in acp-rpc): a relay/
        // agent (re)start resets ACP initialization AND invalidates the stale session id;
        // a reused turn carries both forward.
        const gen = relayStateAfterBoot({ initialized: live.initialized, sessionId: live.sessionId }, relayRebooted);
        live.initialized = gen.initialized;
        live.sessionId = gen.sessionId;
        if (key) {
          threadRelays.set(key, live);
          retainForThread = true;
        }

        // ── JSON-RPC client over the relay (SSE in, POST out) ───────────────
        const sseAbort = new AbortController();

        const post = async (msg: Record<string, unknown>): Promise<void> => {
          const res = await fetch(`${live.baseUrl}/send`, {
            method: "POST",
            headers: { ...authHeaders(live.token), "content-type": "application/json" },
            body: JSON.stringify(msg),
            signal: sseAbort.signal,
          });
          if (!res.ok && res.status !== 204) throw new Error(`relay send failed: HTTP ${res.status}`);
        };
        // JSON-RPC request/response correlation lives in the pure, tested acp-rpc
        // client (over our `post` transport). When the event pump below ends
        // (EOF/error/abort) we `failAll` so no request hangs until the turn timeout.
        const rpc = createAcpRpcClient(post);
        const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
          rpc.request(method, params);

        // Product abort (Stop / run deadline) -> tell the agent to stop NATIVELY
        // (ACP session/cancel) BEFORE we drop the SSE, so it does not keep running
        // server-side after we disconnect. Reject the in-flight turn as `cancelled`
        // (distinct from a relay death), then close the stream as before. Native cancel
        // is wired + request-level tested; a live in-flight proof keeps the engines gated.
        const onParentAbort = () => {
          const sid = live.sessionId;
          if (sid) void sendSessionCancel(live.baseUrl, live.token, sid);
          rpc.failAll("cancelled", "run cancelled");
          sseAbort.abort();
        };
        ctx.signal.addEventListener("abort", onParentAbort, { once: true });

        // Live translation state (reference bot contract: call → step, update → enrich).
        const toolSteps = new Map<string, string>(); // toolCallId → persisted step id
        const toolCalls = new Map<string, Record<string, unknown>>(); // toolCallId → last tool_call payload
        let finalText = "";

        const handleUpdate = async (params: Record<string, unknown>): Promise<void> => {
          const u = (params.update ?? {}) as Record<string, unknown>;
          const kind = String(u.sessionUpdate ?? "");
          if (kind === "agent_message_chunk") {
            const text = ((u.content ?? {}) as { text?: string }).text;
            if (typeof text === "string" && text) {
              finalText += text;
              ctx.publishDelta?.(text);
            }
            return;
          }
          if (kind === "tool_call") {
            const tcid = String(u.toolCallId ?? "");
            if (!tcid || toolSteps.has(tcid)) return;
            toolCalls.set(tcid, u);
            const id = await ctx.emit(acpToolStep(u, undefined));
            if (id) toolSteps.set(tcid, id);
            return;
          }
          if (kind === "tool_call_update") {
            const tcid = String(u.toolCallId ?? "");
            const status = String(u.status ?? "");
            if (!tcid || (status !== "completed" && status !== "failed")) return;
            const call = toolCalls.get(tcid) ?? u;
            const stepId = toolSteps.get(tcid);
            const output = acpContentText(u.content);
            if (stepId) {
              await ctx.updateStep?.(stepId, {
                tool: String(call.kind ?? "other"),
                title: String(call.title ?? ""),
                input: (call.rawInput ?? {}) as Record<string, unknown>,
                output: output.slice(0, 2000),
                status,
              });
            }
            return;
          }
        };

        // Warm the Daytona preview-proxy route BEFORE we commit the long-lived /events
        // stream + POST initialize. The boot health-probe runs via sandbox-exec (NOT the
        // proxy), so the proxy path is COLD on first use and can drop the very first
        // connection through it - observed as an intermittent turn-1 "event stream ended
        // before response". A short GET /health establishes the upstream route first
        // (the relay serves /health before it is even fully ready for JSON-RPC). Cheap
        // and idempotent on a warm proxy (one 200); best-effort - never fails the turn.
        for (let i = 0; i < 10; i++) {
          const warm = await fetch(`${live.baseUrl}/health`, { headers: authHeaders(live.token), signal: sseAbort.signal })
            .then((r) => r.ok)
            .catch(() => false);
          if (warm) break;
          await new Promise((r) => setTimeout(r, 300));
        }

        const pump = (async () => {
          const res = await fetch(`${live.baseUrl}/events`, {
            headers: authHeaders(live.token),
            signal: sseAbort.signal,
          });
          if (!res.ok || !res.body) throw new Error(`relay events failed: HTTP ${res.status}`);
          const decoder = new TextDecoder();
          let buf = "";
          for await (const chunk of res.body) {
            buf += decoder.decode(chunk as Uint8Array, { stream: true });
            let sep: number;
            while ((sep = buf.indexOf("\n\n")) !== -1) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              const data = frame
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("");
              const msg = parseJsonLine(data);
              if (!msg) continue;
              // Response to one of our requests (settled inside the rpc client).
              if (rpc.dispatch(msg)) continue;
              // Server → client REQUEST (permissions): fail CLOSED (deny) unless the
              // dev-only ACP_YOLO_APPROVE opt-in is set. See the handler below.
              if (typeof msg.id === "number" && msg.method === "session/request_permission") {
                // SECURITY (final_harness.md P0): single fail-closed decision point
                // (permission-policy.ts). DENY unless verified-dev yolo.
                const params = (msg.params ?? {}) as { options?: { optionId?: string; kind?: string }[] };
                void post({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: decideAcpPermission(params.options ?? []),
                }).catch(() => {});
                continue;
              }
              // Notifications.
              if (msg.method === "session/update") {
                await handleUpdate((msg.params ?? {}) as Record<string, unknown>);
              }
            }
          }
        })()
          .catch(() => {})
          // The event stream ended (normal turn-end abort, relay death, or network
          // error). Reject EVERY still-pending JSON-RPC request NOW with a stable
          // `relay_disconnected` instead of letting it hang until the turn timeout.
          // Idempotent + a no-op on the happy path (all requests already settled).
          .finally(() => rpc.failAll("relay_disconnected", "ACP relay event stream ended before response"));

        // Wait for the SSE to actually attach before any request (the relay
        // broadcasts only to connected clients — no replay).
        await new Promise((r) => setTimeout(r, 300));

        // ── ACP handshake + the turn ────────────────────────────────────────
        const turnTimeout = setTimeout(() => sseAbort.abort(), Math.max(10_000, budgetMs - (Date.now() - startedAt)));
        try {
          // Initialize ONCE per resident process generation. A reused turn skips it
          // (the agent is already initialized); a (re)started agent has `initialized`
          // reset above, so it initializes again. Belt-and-suspenders: if the relay
          // survived a backend restart (our in-memory flag was lost) the agent is
          // already initialized and codex-acp answers -32603 "Already initialized" -
          // treat that as success; anything else is a real failure.
          if (!live.initialized) {
            try {
              await request("initialize", {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
              });
            } catch (e) {
              if (!isAlreadyInitialized(e)) throw e;
            }
            live.initialized = true;
          }

          // Knowledge MCP gateway at parity with opencode — minted ONCE per turn
          // and passed into both session/load and session/new (run-scoped token).
          const mcpServers = acpKnowledgeMcpServers(ctx);

          // Session: live in-process one wins; else try loading the persisted
          // id; else a fresh session (with the composed preamble).
          let sessionId = live.sessionId;
          let resumed = Boolean(sessionId);
          if (!sessionId && ctx.engineSessionId) {
            try {
              await request("session/load", {
                sessionId: ctx.engineSessionId,
                cwd: live.workdir,
                mcpServers,
              });
              sessionId = ctx.engineSessionId;
              resumed = true;
            } catch {
              sessionId = null; // agent can't load it (fresh process/no support)
            }
          }
          if (!sessionId) {
            const res = await request("session/new", { cwd: live.workdir, mcpServers });
            sessionId = String(res.sessionId ?? "");
            if (!sessionId) throw new Error("ACP session/new returned no sessionId");
            resumed = false;
          }
          live.sessionId = sessionId;
          ctx.saveEngineSessionId?.(sessionId);

          await ctx.emit({ kind: "task", label: `Running ${cfg.id} (resident)…`, chip: cfg.id });
          const promptText = composeTurnPrompt(ctx, resumed);
          const result = await request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: promptText }],
          });
          const stopReason = String(result.stopReason ?? "end_turn");
          if (stopReason === "refusal" || stopReason === "cancelled") {
            throw new Error(`${cfg.id} turn ended: ${stopReason}`);
          }
        } finally {
          clearTimeout(turnTimeout);
          // Let trailing updates land, then close the SSE; the relay + agent
          // stay RESIDENT for the next turn.
          await new Promise((r) => setTimeout(r, 300));
          sseAbort.abort();
          ctx.signal.removeEventListener("abort", onParentAbort);
          await pump;
        }

        if (finalText.trim()) {
          await ctx.emit({ kind: "task", label: truncate(finalText, 60), chip: "task" });
        }
        await ctx.emit({ kind: "done", label: "Done", chip: null });
        ctx.setSummary(finalText.trim() || `${cfg.id} run completed`, Date.now() - startedAt);
        succeeded = true;
      } finally {
        if (sandbox && (!retainForThread || !succeeded)) {
          if (key) threadRelays.delete(key);
          await sandbox.delete().catch(() => {});
        }
      }
    },
  };
}

// ── engine configs ──────────────────────────────────────────────────────────

export const claudeAcpConfig: AcpEngineConfig = {
  id: "claude",
  port: 4097,
  // claude-agent-acp embeds the Agent SDK; CLAUDE_CODE_EXECUTABLE points it at
  // the resident claude binary (also installed) instead of the ~250MB bundled
  // optional dependency.
  packages: [
    { pkg: CLAUDE_CODE_PKG, bin: "claude" },
    { pkg: CLAUDE_ACP_PKG, bin: "claude-agent-acp" },
  ],
  agentCmd: ["claude-agent-acp"],
  agentEnv: { CLAUDE_CODE_EXECUTABLE: "$HOME/.local/bin/claude" },
};

export const acpClaudeAdapter = makeAcpAdapter(claudeAcpConfig);

export const codexAcpConfig: AcpEngineConfig = {
  id: "codex",
  port: 4098,
  packages: [{ pkg: CODEX_ACP_PKG, bin: "codex-acp" }],
  agentCmd: ["codex-acp"],
  // codex-acp requires codex to be LOGGED IN (~/.codex/auth.json), not merely to have
  // OPENAI_API_KEY in env - otherwise it fails the session with "Authentication required".
  // Seed the login from the injected key before the relay starts (idempotent; a no-key
  // sandbox no-ops via `|| true`). `codex login --with-api-key` reads the key from stdin.
  preRelay: 'if [ -n "$OPENAI_API_KEY" ]; then printf %s "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null 2>&1 || true; fi; ',
  // SaaS-SAFE credentials (final_harness.md P0): NO host-credential copy. Codex
  // authenticates only from per-tenant credentials injected via org secrets
  // (OPENAI_API_KEY) - we never copy the host operator's ~/.codex/auth.json (a
  // developer's ChatGPT login) into an untrusted customer sandbox. Fail-closed: an
  // enabled codex run without an injected credential fails on codex's own auth error.
};

export const acpCodexAdapter = makeAcpAdapter(codexAcpConfig);
