import { daytonaProvider, type SandboxHandle } from "../sandboxes/provider";
import type { EngineAdapter, EngineRunContext } from "./types";
import { composeTurnPrompt } from "./types";
import {
  ACP_COMMANDS_EVENT_TYPE,
  SESSION_STARTED_EVENT_TYPE,
  parseAcpAvailableCommands,
  type CanonicalCommand,
} from "@skynet/agent-harness/canonical";
import { sessionCapabilities } from "./capabilities";
import { parseJsonLine, persistSandboxBeforeExecution, truncate } from "./util";
import { prepareRepos, shq } from "./repo-prep";
import { serialStartup } from "../util/startup";
import { parseRepoRef } from "../github/repo-ref";
import { cacheAcpCommands } from "../runs/command-catalog";
import { revalidateCommandBeforeDispatch } from "../runs/command-intent";
import { providerEventExists, recordProviderEvent } from "../runs/provider-events";
import { buildSessionCancel, createAcpRpcClient, isAlreadyInitialized, parseRelayHealth, relayRegenerated, relayStateAfterBoot } from "./acp-rpc";
import { decideAcpPermission } from "./permission-policy";
import { toolGatewayConfig } from "../knowledge/gateway/config";
import { mintToolToken } from "../knowledge/gateway/token";
import {
  composeSecretEnv,
  materializeSecretFiles,
  PROVIDER_SECRET_NAMES,
  recordSecretsInjected,
  SECRET_SOURCE_COMMAND,
} from "../secrets/inject";
import { createSecretRedactor } from "../secrets/redact";
import { ensureSandboxDesktop, ensureSandboxDesktopView } from "./desktop";
import { acpBrowserMcpServer, registerClaudeBrowserMcp } from "./browser-mcp";
import { getThreadSandbox, setRunSandbox } from "../runs/repo";
import {
  buildAcpToolCompletion,
  buildAcpToolStep,
  type AcpToolNativeIds,
} from "./acp-tool-step";
import {
  providerGatewayEnv,
  providerGatewayWired,
  prepareProviderGatewaySandbox,
  providerGatewaySandboxIsCurrent,
  providerGatewaySandboxLabels,
} from "../provider-gateway/sandbox-config";
import { extractAcpToolOutput } from "./acp-content";
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

export const CLAUDE_ACP_PKG = "@agentclientprotocol/claude-agent-acp@0.66.0";
// codex-acp@0.16.0 does not exist under this namespace (that version belongs to
// @zed-industries/codex-acp) - the 404 silently no-op'd the install so `codex-acp` never
// landed and the relay's child spawn failed (BOOT-TIMEOUT). The real package is 1.1.x and
// bundles @openai/codex (the `codex` binary) as a dependency, so installing it provisions
// codex too (#128).
export const CODEX_ACP_PKG = "@agentclientprotocol/codex-acp@1.1.14";
export const CLAUDE_CODE_PKG = "@anthropic-ai/claude-code@2.1.226";

/** The in-sandbox relay: stdin/stdout bridge to the ACP agent over plain HTTP
 *  (SSE out, POST in) — WebSockets are unnecessary and unproven through the
 *  preview proxy, SSE is proven (opencode /event). Node built-ins only. */
export const RELAY_SCRIPT = `
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const PORT = Number(process.argv[2]);
const CMD = process.argv[3];
const ARGS = process.argv.slice(4);
let child = null;
let generation = 0;   // bumps on every (re)boot of the ACP CHILD (the relay HTTP server stays up)
let childAlive = false;
let childReady = false; // the child is spawned AND has had a moment to come up (accept stdin)
let lastExit = null;
let shuttingDown = false;
const clients = new Set();
function emit(line) { for (const res of clients) res.write("data: " + line + "\\n\\n"); }
function boot() {
  let buf = "";
  generation += 1;
  childReady = false;
  child = spawn(CMD, ARGS, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  childAlive = true;
  // READINESS: mark ready once the child produces its first stdout (an ACP agent greets on
  // start), or after a short grace window - whichever comes first. Until then /send is rejected
  // so we never write a prompt into a child that is not yet accepting input.
  const readyTimer = setTimeout(() => { if (childAlive) childReady = true; }, 750);
  child.stdout.on("data", (d) => {
    childReady = true;
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) emit(line);
    }
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.on("exit", (code, signal) => {
    clearTimeout(readyTimer);
    childAlive = false;
    childReady = false;
    lastExit = { code, signal };
    // Tell connected clients the ACP CHILD died: the backend fails pending RPC immediately and
    // treats the next turn as a NEW generation (never prompts the stale native session).
    emit(JSON.stringify({ __relay: "child_exit", generation, code, signal }));
    if (!shuttingDown) setTimeout(boot, 1000); // respawn -> a NEW generation (unless shutting down)
  });
}
// CLEANUP: on relay shutdown, stop respawning and kill the child so it is never orphaned.
function cleanup() { shuttingDown = true; try { if (child) child.kill("SIGTERM"); } catch (e) {} process.exit(0); }
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
boot();
createServer((req, res) => {
  if (req.url === "/health") {
    // JSON so the backend can distinguish RELAY health from ACP CHILD health and observe the
    // child generation + readiness. No secrets - just liveness + generation + a sanitized last-exit.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ relay: "ok", generation, childAlive, childReady, pid: (child && child.pid) || null, lastExit }));
    return;
  }
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
      // Guard: never write into a dead/not-yet-ready child (its stdin would throw or be lost).
      if (!child || !childAlive || !childReady) { res.writeHead(503); res.end("child not ready"); return; }
      try { child.stdin.write(b.trim() + "\\n"); res.writeHead(204); res.end(); }
      catch (e) { res.writeHead(503); res.end(String(e)); }
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
  prepare?(sandbox: SandboxHandle, ctx: EngineRunContext): Promise<void>;
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

const RUNTIME_ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const HOME_RUNTIME_PATH_RE = /^\$HOME(?:\/[A-Za-z0-9._-]+)+$/;

/** Explicit exports for the resident ACP relay. Daytona snapshots launch zsh,
 * so container-level BASH_ENV is not a reliable delivery mechanism. Gateway
 * endpoints are regenerated on every control-plane boot/tunnel and must also
 * override immutable envVars on a durable sandbox reconnect. */
export function buildAcpRuntimeEnvExports(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([name, value]) => {
      if (!RUNTIME_ENV_NAME_RE.test(name)) {
        throw new Error(`invalid ACP runtime environment name: ${name}`);
      }
      const rendered = HOME_RUNTIME_PATH_RE.test(value) ? `"${value}"` : shq(value);
      return `export ${name}=${rendered}; `;
    })
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
  /** The ACP CHILD generation last observed from the relay `/health`. The child can die +
   *  respawn INSIDE a still-up relay HTTP server; a changed generation invalidates the
   *  in-memory session id + initialization exactly like a full relay restart. */
  generation: number | null;
  /** Latest command replacement observed from this resident child generation.
   *  Cleared whenever the child/session is replaced; send-time authorization
   *  never falls back to a historical DB snapshot. */
  commandCatalog: { sessionId: string; commands: readonly CanonicalCommand[] } | null;
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

/** Targeted native ACP cancel for the CONTROL adapter (HarnessAdapter.cancel): find the live
 *  resident relay for (sandbox, session) and send a native `session/cancel`. Returns true when a
 *  live relay was found and the cancel was sent. The run's own Stop already sends this via the
 *  abort path during a turn; this lets the typed control seam report the truth (cancel IS wired)
 *  instead of a stale `unsupported_capability`. */
export async function cancelAcpSession(sandboxId: string, sessionId: string): Promise<boolean> {
  for (const relay of threadRelays.values()) {
    if (relay.sandboxId === sandboxId && relay.sessionId === sessionId) {
      await sendSessionCancel(relay.baseUrl, relay.token, sessionId);
      return true;
    }
  }
  return false;
}

/**
 * Build the ACP `mcpServers` array carrying the Skynet knowledge gateway — the
 * ACP-native equivalent of OpenCode's knowledge portion of
 * ensureOpencodeSandboxConfig. Passed into
 * BOTH session/new and session/load so a fresh AND a resumed ACP session can call
 * knowledge_search / knowledge_read, at parity with opencode.
 *
 * TRUST BOUNDARY (identical to opencode): the ONLY thing that enters the
 * untrusted sandbox is a short-lived, run-scoped bearer TOKEN over HTTP — never
 * DB/embedding/tenant credentials. The gateway derives org/user/thread from the
 * token server-side. Same URL, TTL, and minted identity as the opencode path.
 *
 * Gated: empty unless GATEWAY_PUBLIC_URL is set AND the run has an org
 * identity (fail closed — no tools rather than an unscoped one). Off by default,
 * so existing ACP runs are byte-for-byte unchanged.
 *
 * Shape: the ACP HTTP MCP-server descriptor `{ type:"http", name, url, headers }`.
 * The descriptor is contract-tested and has been exercised by the live Claude
 * journey; absence is represented honestly as an empty server list.
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

// ── the adapter ─────────────────────────────────────────────────────────────

function makeAcpAdapter(cfg: AcpEngineConfig): EngineAdapter {
  return {
    id: cfg.id,

    async run(ctx: EngineRunContext): Promise<void> {
      const apiKey = process.env.DAYTONA_API_KEY;
      if (!apiKey) throw new Error(`${cfg.id} engine needs DAYTONA_API_KEY in the backend env`);
      if (!providerGatewayWired()) {
        throw new Error(`${cfg.id} engine requires a configured provider gateway`);
      }
      const startedAt = Date.now();
      const daytona = daytonaProvider(apiKey);
      const budgetMs = resolveAcpTurnTimeoutMs();

      // Org secrets live in a protected dotenv, not in Daytona's immutable env
      // catalog (which rejects large org catalogs). The ACP relay sources it
      // explicitly at boot; BASH_ENV is only a compatibility path. The names-only
      // marker is recorded only after the files are materialized successfully.
      const secretInjection = await composeSecretEnv(ctx, {
        excludeNames: PROVIDER_SECRET_NAMES,
      });
      const redact = createSecretRedactor(secretInjection.redactionValues);
      // Provider credentials never enter the sandbox. The dedicated gateway
      // resolves the org credential server-side from the exact running run.
      const runtimeProviderEnv = providerGatewayEnv(ctx, cfg.id);
      const envVars: Record<string, string> = {
        ...secretInjection.createEnv,
        ...runtimeProviderEnv,
      };

      const autoStopInterval = Number(process.env.SANDBOX_AUTO_STOP_MIN ?? 30);
      const autoDeleteInterval = Number(process.env.SANDBOX_AUTO_DELETE_MIN ?? 4320);
      const snapshot = process.env.DAYTONA_ACP_SNAPSHOT ?? "skynet-acp-v2";
      const resourceTarget = resolveSandboxResourceTarget();

      const key = ctx.threadId ? relayKey(ctx.threadId, cfg.id) : null;
      let relay = key ? threadRelays.get(key) : undefined;
      let sandbox: SandboxHandle | null = null;
      let retainForThread = false;
      let snapshotBacked = false;

      try {
        // ── sandbox: reuse the thread's, else provision ─────────────────────
        const endSandboxSpan = ctx.timing?.begin("sandbox");
        if (relay) {
          try {
            const cachedSandbox = ctx.threadId ? getLiveThreadSandbox(ctx.threadId) : null;
            const prior =
              cachedSandbox?.id === relay.sandboxId
                ? cachedSandbox
                : await daytona.get(relay.sandboxId);
            const state = (prior as { state?: string }).state;
            if (state === "stopped" || state === "paused" || state === "archived") {
              await ctx.emit({ kind: "task", label: `Resuming thread sandbox ${prior.id.slice(0, 8)}…`, chip: cfg.id });
              await prior.start();
              relay.sessionId = null; // agent process died with the stop
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
            if (key) threadRelays.delete(key);
            if (ctx.threadId) forgetLiveThreadSandbox(ctx.threadId, relay.sandboxId);
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
              const cachedSandbox = getLiveThreadSandbox(ctx.threadId);
              const prior =
                cachedSandbox?.id === priorId
                  ? cachedSandbox
                  : await daytona.get(priorId);
              const state = (prior as { state?: string }).state;
              if (state === "stopped" || state === "paused" || state === "archived") {
                await ctx.emit({ kind: "task", label: `Resuming thread sandbox ${prior.id.slice(0, 8)}…`, chip: cfg.id });
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
              forgetLiveThreadSandbox(ctx.threadId, priorId);
              sandbox = null; // persisted sandbox is gone/unusable — provision fresh
            }
          }
        }
        if (sandbox && !sandboxMeetsResourceTarget(sandbox, resourceTarget)) {
          const staleId = sandbox.id;
          await sandbox.delete().catch(() => {});
          if (key) threadRelays.delete(key);
          if (ctx.threadId) forgetLiveThreadSandbox(ctx.threadId, staleId);
          relay = undefined;
          sandbox = null;
          retainForThread = false;
          await ctx.emit({
            kind: "task",
            label: "Replacing an undersized retained sandbox…",
            chip: cfg.id,
          });
        }

        const provisionedFresh = !sandbox;
        if (provisionedFresh) {
          await ctx.emit({ kind: "task", label: "Provisioning cloud sandbox…", chip: cfg.id });
          const sandboxConfig = {
            envVars,
            labels: providerGatewaySandboxLabels(ctx.runId),
            autoStopInterval,
            autoDeleteInterval,
          };
          try {
            // ACP dependencies are pinned in a non-root Daytona snapshot. This
            // removes three fresh-thread npm installs while preserving the
            // default `daytona` user Claude requires. A missing/inactive image
            // degrades to the ordinary image and the idempotent install clause.
            sandbox = await daytona.create({ snapshot, ...sandboxConfig });
            snapshotBacked = true;
          } catch {
            sandbox = await daytona.create(sandboxConfig);
          }
        }
        if (!sandbox) throw new Error("Daytona returned no sandbox");
        const box = sandbox;
        const resources = assertSandboxResources(box, resourceTarget);
        if (provisionedFresh) {
          await ctx.emit({
            kind: "task",
            label: `Sandbox ${box.id.slice(0, 8)} ready in ${Math.round((Date.now() - startedAt) / 1000)}s (${resources.cpu} CPU / ${resources.memory} GiB)`,
            chip: cfg.id,
          });
        }
        if (ctx.signal.aborted) throw new Error(`${cfg.id} run aborted (timeout)`);
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
          if (ctx.threadId) rememberLiveThreadSandbox(ctx.threadId, box);
        } catch (err) {
          // The helper already tore down a FRESHLY provisioned box; clear the ref so the
          // run's finally (which also deletes on !succeeded) does not delete it a SECOND
          // time. A reused resident box was NOT touched by the helper - leave `sandbox` set
          // so its existing (unchanged) finally lifecycle still applies.
          if (!retainForThread) sandbox = null;
          throw err;
        }

        endSandboxSpan?.();
        await ctx.emit({
          kind: "task",
          label: "Preparing browser, tools, and integrations…",
          chip: cfg.id,
        });
        const endPrepareSpan = ctx.timing?.begin("prepare");

        // A snapshot-backed box already has every pinned binary, so its desktop,
        // resident browser MCP, and Claude MCP registration can warm while the
        // trusted control plane materializes run-scoped gateway credentials and
        // boots the ACP relay. A fallback/legacy box starts only the VNC view
        // early: its npm installs remain sequential to avoid corrupting the shared
        // user prefix with concurrent global installs.
        const desktopPreparation = snapshotBacked
          ? ensureSandboxDesktop(box, ctx.signal)
          : ensureSandboxDesktopView(box, ctx.signal);
        const earlyClaudeBrowserRegistration = snapshotBacked && cfg.id === "claude"
          ? registerClaudeBrowserMcp(box)
          : Promise.resolve(false);
        // Rollback flag: sequence the floated preparation before continuing (same
        // DAG at concurrency 1). Errors still surface at the original await sites.
        if (serialStartup()) {
          await desktopPreparation.catch(() => {});
          await earlyClaudeBrowserRegistration.catch(() => {});
        }

        await cfg.prepare?.(box, ctx);

        const probeCmd = `curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:${cfg.port}/health`;
        const relayPidPath = `/tmp/acp-relay-${cfg.id}.pid`;

        // Reconcile the protected directory on every turn. A revision change
        // includes addition, rotation, and revocation. A backend restart also
        // loses the in-memory relay/session generation, so restart rather than
        // session/load into an already-loaded child. In both cases only the
        // small relay restarts; the Daytona workspace and native session stay.
        const secretState = await materializeSecretFiles(
          (cmd) => box.process.executeCommand(cmd, undefined, undefined, 30),
          secretInjection.files,
        );
        await recordSecretsInjected(ctx, secretInjection);
        const reconnectingToResidentProcess = retainForThread && !relay;
        if (retainForThread && (secretState.changed || reconnectingToResidentProcess)) {
          const stopped = await box.process.executeCommand(
            `if [ -f ${relayPidPath} ]; then ` +
              `relay_pid=$(cat ${relayPidPath}); ` +
              `kill "$relay_pid" 2>/dev/null || true; ` +
              `fi; ` +
              `for i in $(seq 1 40); do [ "$(${probeCmd})" = "000" ] && break; sleep 0.25; done; ` +
              `[ "$(${probeCmd})" = "000" ] && rm -f ${relayPidPath}`,
            undefined,
            undefined,
            30,
          );
          if ((stopped.exitCode ?? 1) !== 0) {
            throw new Error(`${cfg.id} ACP relay did not stop after secret revision change`);
          }
        }

        // ── resident agent: install once, relay up, resolve endpoint ────────
        const relayB64 = Buffer.from(RELAY_SCRIPT, "utf8").toString("base64");
        const agentEnvExports = buildAcpRuntimeEnvExports({
          ...runtimeProviderEnv,
          ...(cfg.agentEnv ?? {}),
        });
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
            `${SECRET_SOURCE_COMMAND} || { echo SECRET-ENV-FAIL; exit 1; }; ` +
            `${agentEnvExports}cd ~/work || exit 1; ` +
            `nohup node ~/acp-relay.mjs ${cfg.port} ${cfg.agentCmd.join(" ")} > /tmp/acp-relay-${cfg.id}.log 2>&1 & ` +
            `relay_pid=$!; echo "$relay_pid" > ${relayPidPath}; ` +
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
        const preparedDesktop = await desktopPreparation;
        const desktop = snapshotBacked
          ? preparedDesktop
          : await ensureSandboxDesktop(box, ctx.signal);
        const browserToolsReady = desktop.browserTools && (
          cfg.id !== "claude" ||
          await earlyClaudeBrowserRegistration ||
          await registerClaudeBrowserMcp(box)
        );
        if (!desktop.available || !browserToolsReady) {
          await ctx.emit({
            kind: "task",
            label: desktop.reason ?? (
              desktop.browserTools
                ? "Claude browser MCP registration failed"
                : "Desktop/browser tools unavailable in this sandbox"
            ),
            chip: "warning",
          });
        }
        // A relay (re)boot this call means a fresh agent process - the previous turn's
        // in-memory native session id is dead. Invalidate it below so we session/load
        // (persisted id) or session/new instead of prompting a stale session.
        const relayRebooted = / BOOTED=1/.test(boot.result ?? "");
        // Observe the ACP CHILD generation from /health. The relay HTTP server can survive while
        // its child (the agent) dies + respawns internally (a NEW generation); BOOTED only
        // detects an HTTP-server restart, so without this a warm turn would prompt the stale
        // native session of a dead child. Compare against the generation we last saw for THIS
        // relay; a change invalidates the session id + initialization just like a full restart.
        const priorGeneration = relay?.generation ?? null;
        // Wait for the ACP CHILD to be READY (not just for the relay HTTP server) before the
        // handshake - a prompt sent to a not-yet-ready child is rejected by the /send guard.
        let health = { relay: "ok", generation: null as number | null, childAlive: true, childReady: false };
        for (let i = 0; i < 24; i++) {
          const out = (await box.process.executeCommand(
            `curl -s -m 3 http://127.0.0.1:${cfg.port}/health`,
            undefined,
            undefined,
            15,
          ).catch(() => ({ result: "" }))).result ?? "";
          health = parseRelayHealth(out);
          if (health.childReady) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        const childRegenerated = relayRegenerated(priorGeneration, health.generation);
        endPrepareSpan?.();

        // Prepare the thread's selected repos into the workspace BEFORE the ACP session
        // starts, so the resident agent works INSIDE them. Shared, engine-neutral preparer -
        // same secure clone as OpenCode; idempotent on a warm sandbox (fast skips).
        const endReposSpan = ctx.timing?.begin("repos");
        await prepareRepos(box, `${home}/work`, ctx);
        endReposSpan?.();
        // EFFECTIVE working directory: a single-repo thread starts the session INSIDE that
        // repo (`~/work/<owner>/<name>`), so relative tool paths, `git`, and file ops resolve
        // in the repo the user chose - not a bare workspace root. Multi-repo or no-repo threads
        // keep the workspace root so every repo is reachable.
        const repoList = ctx.repos ?? [];
        const effectiveCwd =
          repoList.length === 1 ? `${home}/work/${parseRepoRef(repoList[0]!).repo}` : `${home}/work`;

        if (!relay) {
          const link = await box.getPreviewLink(cfg.port);
          relay = {
            sandboxId: box.id,
            baseUrl: link.url.replace(/\/+$/, ""),
            token: link.token ?? "",
            workdir: `${home}/work`,
            sessionId: null,
            initialized: false,
            generation: health.generation,
            commandCatalog: null,
          };
        }
        const live = relay; // narrowed non-null for the closures below
        // Restart-generation state machine (single source of truth in acp-rpc): a relay/agent
        // (re)start OR an in-place ACP-child regeneration resets ACP initialization AND
        // invalidates the stale session id; a reused turn on the SAME generation carries both
        // forward.
        const regenerated = relayRebooted || childRegenerated;
        const gen = relayStateAfterBoot({ initialized: live.initialized, sessionId: live.sessionId }, regenerated);
        live.initialized = gen.initialized;
        live.sessionId = gen.sessionId;
        live.generation = health.generation ?? live.generation;
        if (regenerated) live.commandCatalog = null;
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
        const toolCalls = new Map<
          string,
          { update: Record<string, unknown>; native: AcpToolNativeIds }
        >();
        let finalText = "";
        // session/load replays historical messages before its JSON-RPC response.
        // Keep command-catalog updates, but do not attribute replayed text/tools
        // to the new run. The ordered relay stream guarantees every pre-response
        // replay frame is drained before request("session/load") resolves.
        let acceptingTurnOutput = false;

        // ACP streams chunks but does not assign assistant-message ids. Synthesize one stable
        // message/part per CONTIGUOUS text burst: every chunk within a burst UPSERTS the same
        // cumulative part; a tool call closes the burst, gets its own ordering anchor, and later
        // text starts a new burst. This preserves narration -> tool -> answer order without ever
        // regressing to one React node per token/chunk.
        let nextTextBurst = 0;
        let activeTextBurst: { messageId: string; partId: string; text: string } | null = null;
        // Reasoning ("thinking") bursts, mirroring the text-burst machinery but
        // recorded as part.reasoning so the shared translator emits
        // reasoning.delta/completed (never a message node). A distinct messageId
        // namespace keeps them separate from answer messages.
        let nextReasoningBurst = 0;
        let activeReasoningBurst: { messageId: string; partId: string; text: string } | null = null;
        const recordAcpFrame = (
          id: string,
          eventType: string,
          payload: Record<string, unknown>,
          native: { messageId: string; partId: string },
        ): void => {
          void recordProviderEvent({
            id,
            runId: ctx.runId,
            threadId: ctx.threadId ?? ctx.runId,
            provider: cfg.id,
            eventType,
            nativeSessionId: live.sessionId ?? ctx.runId,
            nativeMessageId: native.messageId,
            nativePartId: native.partId,
            payload,
          });
        };
        const closeTextBurst = (): void => {
          if (!activeTextBurst) return;
          const burst = activeTextBurst;
          recordAcpFrame(
            `${burst.messageId}_finish`,
            "part.step-finish",
            {},
            { messageId: burst.messageId, partId: `${burst.messageId}_finish` },
          );
          activeTextBurst = null;
        };
        // Close the current reasoning burst with part.reasoning.completed so the
        // translator seals a reasoning.completed. Called when the answer starts, a
        // tool runs, or the turn ends - whichever comes first.
        const closeReasoningBurst = (): void => {
          if (!activeReasoningBurst) return;
          const burst = activeReasoningBurst;
          recordAcpFrame(
            `${burst.messageId}_finish`,
            "part.reasoning.completed",
            {},
            { messageId: burst.messageId, partId: `${burst.messageId}_finish` },
          );
          activeReasoningBurst = null;
        };

        const handleUpdate = async (params: Record<string, unknown>): Promise<void> => {
          const u = redact.unknown((params.update ?? {}) as Record<string, unknown>);
          const kind = String(u.sessionUpdate ?? "");
          if (kind === "available_commands_update") {
            // The provider's native slash-command catalog for THIS session - a REPLACEMENT
            // snapshot (an empty list means "no commands right now"). Capture it durably in
            // the ORDERED provider-events lane, keyed by the ACP session id read from the
            // notification params (id `<sessionId>:commands`, upserted so the LATEST
            // replacement wins and duplicates are idempotent). Because it is a provider event
            // it is sealed by the same drain barrier and counted by the same canonicalization
            // watermark as every other native frame - so canonicalization cannot reach
            // `complete` until this snapshot is durable, and two native sessions in one thread
            // keep DISTINCT catalogs. The translator emits the run's canonical
            // `commands.updated` from these frames (empty replacement honored).
            const sessionId = typeof params.sessionId === "string" && params.sessionId
              ? params.sessionId
              : (live.sessionId ?? ctx.runId);
            const snapshot = parseAcpAvailableCommands(u);
            // STRICT command-catalog persistence: the catalog is authoritative for the session,
            // so persist it durably before continuing (AWAIT, not fire-and-forget) with bounded
            // retries and a VISIBLE error on final failure - never silently omit it. The upsert
            // is idempotent, so a retry is safe.
            const commandFrame = {
              // RUN-scoped id (the provider-events PK is global): a resumed session reuses its
              // sessionId across turns, so a bare `<sessionId>:commands` would collide and let
              // one turn's frame upsert another turn's row. `<runId>:<sessionId>:commands` keeps
              // each (run, session) distinct while still upserting duplicates within a turn.
              id: `${ctx.runId}:${sessionId}:commands`,
              runId: ctx.runId,
              threadId: ctx.threadId ?? ctx.runId,
              provider: cfg.id,
              eventType: ACP_COMMANDS_EVENT_TYPE,
              nativeSessionId: sessionId,
              payload: {
                source: cfg.id,
                adapter: cfg.packages.map((p) => p.pkg).join(","),
                commands: snapshot,
                ts: Date.now(),
              },
            };
            let persisted = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              await recordProviderEvent(commandFrame, { critical: true });
              // Read-back: the serial chain swallows a failed insert (it must stay resolvable),
              // so verify the row landed and retry the idempotent upsert if it did not.
              if (await providerEventExists(commandFrame.id)) { persisted = true; break; }
              if (attempt < 2) await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
            }
            // C4 fail-closed: the AUTHORITATIVE catalog is the durable commands.updated. If it
            // could not be persisted, DEGRADE the command capability VISIBLY - do NOT fall back to
            // only populating the org priming cache (that is UI-only and would advertise commands
            // the session cannot authorize, since accept-time validation reads the durable catalog
            // and now finds none). The command capability is simply unavailable for this session
            // until it re-advertises; core chat is unaffected.
            if (!persisted) {
              if (live.commandCatalog?.sessionId === sessionId) live.commandCatalog = null;
              console.error(`[acp:${cfg.id}] command catalog NOT persisted after retries (run ${ctx.runId}) - command capability DEGRADED for session ${sessionId.slice(0, 8)}`);
              void ctx.emit({ kind: "task", label: "Native commands unavailable for this session (catalog could not be persisted)", chip: "warning" });
            } else {
              // This is the provider's CURRENT replacement snapshot for the
              // resident child generation. Keep it outside the DB projection so
              // send-time revalidation cannot accidentally read yesterday's
              // canonical catalog and call it live.
              live.commandCatalog = { sessionId, commands: snapshot };
              // Keep the ORG New Task priming cache SEPARATE from authoritative session state:
              // upsert only a NON-empty snapshot (a transient empty frame must not wipe the
              // pre-session picker). Fire-and-forget: a caching failure never disturbs the turn.
              void cacheAcpCommands(ctx.orgId ?? "", cfg.id, snapshot);
            }
            return;
          }
          if (!acceptingTurnOutput) return;
          if (kind === "agent_thought_chunk") {
            const text = ((u.content ?? {}) as { text?: string }).text;
            if (typeof text === "string" && text) {
              // Live: publish on the SAME reasoning lane Phase 4 built, so claude
              // and codex turns get the subdued live "Thinking" affordance for free.
              ctx.publishDelta?.(text, "reasoning");
              // Durable: mirror the text burst as part.reasoning (cumulative). No
              // part.step-start - reasoning must not synthesize a message node.
              if (!activeReasoningBurst) {
                const messageId = `msg_${ctx.runId}_reasoning_${nextReasoningBurst++}`;
                activeReasoningBurst = { messageId, partId: `${messageId}_reasoning`, text: "" };
              }
              activeReasoningBurst.text += text;
              recordAcpFrame(
                activeReasoningBurst.partId,
                "part.reasoning",
                { text: activeReasoningBurst.text },
                { messageId: activeReasoningBurst.messageId, partId: activeReasoningBurst.partId },
              );
            }
            return;
          }
          if (kind === "agent_message_chunk") {
            // The answer is starting - thinking is done, seal the reasoning burst.
            closeReasoningBurst();
            const text = ((u.content ?? {}) as { text?: string }).text;
            if (typeof text === "string" && text) {
              finalText += text;
              ctx.publishDelta?.(text);
              if (!activeTextBurst) {
                const messageId = `msg_${ctx.runId}_text_${nextTextBurst++}`;
                activeTextBurst = { messageId, partId: `${messageId}_text`, text: "" };
                recordAcpFrame(
                  `${messageId}_start`,
                  "part.step-start",
                  {},
                  { messageId, partId: `${messageId}_start` },
                );
              }
              activeTextBurst.text += text;
              recordAcpFrame(
                activeTextBurst.partId,
                "part.text",
                { text: activeTextBurst.text },
                { messageId: activeTextBurst.messageId, partId: activeTextBurst.partId },
              );
            }
            return;
          }
          if (kind === "tool_call") {
            const tcid = String(u.toolCallId ?? "");
            if (!tcid || toolSteps.has(tcid)) return;
            closeReasoningBurst();
            closeTextBurst();
            const messageId = `msg_${ctx.runId}_tool_${tcid}`;
            const native = {
              sessionID: live.sessionId ?? ctx.runId,
              messageID: messageId,
              partID: `${messageId}_part`,
              callID: tcid,
            } satisfies AcpToolNativeIds;
            recordAcpFrame(
              `${messageId}_start`,
              "part.step-start",
              {},
              { messageId, partId: `${messageId}_start` },
            );
            toolCalls.set(tcid, { update: u, native });
            const id = await ctx.emit(buildAcpToolStep(u, undefined, native));
            if (id) toolSteps.set(tcid, id);
            return;
          }
          if (kind === "tool_call_update") {
            const tcid = String(u.toolCallId ?? "");
            const status = String(u.status ?? "");
            if (!tcid || (status !== "completed" && status !== "failed")) return;
            const recorded = toolCalls.get(tcid);
            const call = recorded?.update ?? u;
            const stepId = toolSteps.get(tcid);
            const output = extractAcpToolOutput(u.content, u.rawOutput);
            if (stepId) {
              await ctx.updateStep?.(
                stepId,
                buildAcpToolCompletion(
                  call,
                  output,
                  recorded?.native,
                  status === "failed",
                ),
              );
            }
            if (recorded) {
              recordAcpFrame(
                `${recorded.native.messageID}_finish`,
                "part.step-finish",
                {},
                {
                  messageId: recorded.native.messageID,
                  partId: `${recorded.native.messageID}_finish`,
                },
              );
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
          let warm = false;
          try {
            const response = await fetch(`${live.baseUrl}/health`, {
              headers: authHeaders(live.token),
              signal: sseAbort.signal,
            });
            warm = response.ok;
            await response.body?.cancel();
          } catch {
            // A cold Daytona preview route is expected here; retry below.
          }
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
              // Relay control frame: the resident ACP CHILD died mid-turn. Fail every pending
              // request NOW (don't hang until the turn timeout) and end the turn; the next turn
              // observes the new generation via /health and re-initializes instead of prompting
              // the dead session.
              if ((msg as { __relay?: unknown }).__relay === "child_exit") {
                rpc.failAll("relay_disconnected", "ACP child process exited");
                sseAbort.abort();
                continue;
              }
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
          const knowledgeMcpServers = acpKnowledgeMcpServers(ctx);
          const browserMcpServers =
            browserToolsReady && desktop.browserExecutable
              ? [acpBrowserMcpServer()]
              : [];
          const mcpServers = [...knowledgeMcpServers, ...browserMcpServers];

          // Session: live in-process one wins; else try loading the persisted
          // id; else a fresh session (with the composed preamble).
          let sessionId = live.sessionId;
          let resumed = Boolean(sessionId);
          if (!sessionId && ctx.engineSessionId) {
            try {
              await request("session/load", {
                sessionId: ctx.engineSessionId,
                cwd: effectiveCwd,
                mcpServers,
              });
              sessionId = ctx.engineSessionId;
              resumed = true;
            } catch {
              sessionId = null; // agent can't load it (fresh process/no support)
            }
          }
          if (!sessionId) {
            const res = await request("session/new", { cwd: effectiveCwd, mcpServers });
            sessionId = String(res.sessionId ?? "");
            if (!sessionId) throw new Error("ACP session/new returned no sessionId");
            resumed = false;
          }
          live.sessionId = sessionId;
          if (live.commandCatalog?.sessionId !== sessionId) live.commandCatalog = null;
          ctx.saveEngineSessionId?.(sessionId);

          // C3/D4 fail-closed re-validation IMMEDIATELY before dispatch: a native command must STILL
          // be authorized against the LIVE session. Re-check against the resident provider's current
          // catalog: provider (matches the engine), session identity (session/load failed -> a new
          // session, or the relay regenerated to a different id), and command MEMBERSHIP (the command
          // is still advertised - a re-advertised session that dropped it, or an authorized revision
          // that regressed, is rejected). An ordinary prompt is unaffected (no commandName).
          if (ctx.commandName) {
            const reason = revalidateCommandBeforeDispatch(
              { name: ctx.commandName, provider: ctx.commandProvider ?? null, sessionId: ctx.commandSessionId ?? null, catalogRevision: ctx.commandCatalogRevision ?? null },
              { engine: cfg.id, sessionId, catalog: live.commandCatalog?.commands ?? null },
            );
            if (reason) {
              throw new Error(`stale command "/${ctx.commandName}" rejected before dispatch: ${reason} - re-issue it against the current session`);
            }
          }

          // Emit session.started with the ONE negotiated capability map the UI gates on (never a
          // provider-name guess). Durable via the provider-events lane -> canonical session.started.
          // Runtime resources are advertised from their real provisioning
          // results, never from the engine name.
          void recordProviderEvent({
            id: `${ctx.runId}:${sessionId}:session`,
            runId: ctx.runId,
            threadId: ctx.threadId ?? ctx.runId,
            provider: cfg.id,
            eventType: SESSION_STARTED_EVENT_TYPE,
            nativeSessionId: sessionId,
            payload: {
              source: cfg.id,
              capabilities: sessionCapabilities(cfg.id, {
                desktop: desktop.available,
                knowledgeTools: knowledgeMcpServers.length > 0,
              }),
            },
          });

          await ctx.emit({ kind: "task", label: `Running ${cfg.id} (resident)…`, chip: cfg.id });
          const promptText = composeTurnPrompt(ctx, resumed);
          acceptingTurnOutput = true;
          ctx.timing?.mark("dispatch");
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

        // Close the final durable assistant + reasoning bursts so canonical seals
        // message.completed / reasoning.completed.
        closeReasoningBurst();
        closeTextBurst();
        if (finalText.trim()) {
          await ctx.emit({ kind: "task", label: truncate(finalText, 60), chip: "task" });
        }
        await ctx.emit({ kind: "done", label: "Done", chip: null });
        ctx.setSummary(finalText.trim() || `${cfg.id} run completed`, Date.now() - startedAt);
      } finally {
        // Once a relay is durable for a thread, a failed/cancelled TURN must not
        // destroy the conversation's workspace and native session. A failure
        // before relay registration still removes the unusable fresh sandbox.
        if (sandbox && !retainForThread) {
          if (key) threadRelays.delete(key);
          if (ctx.threadId) forgetLiveThreadSandbox(ctx.threadId, sandbox.id);
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
  prepare: (sandbox, ctx) => prepareProviderGatewaySandbox(sandbox, ctx, "claude"),
};

export const acpClaudeAdapter = makeAcpAdapter(claudeAcpConfig);

export const codexAcpConfig: AcpEngineConfig = {
  id: "codex",
  port: 4098,
  packages: [{ pkg: CODEX_ACP_PKG, bin: "codex-acp" }],
  agentCmd: ["codex-acp"],
  prepare: (sandbox, ctx) => prepareProviderGatewaySandbox(sandbox, ctx, "codex"),
  // SaaS-safe credentials: no host login or raw provider key is copied. Codex
  // reads an exact-run capability from its private token file and calls only the
  // trusted gateway; the backend resolves the tenant credential server-side.
};

export const acpCodexAdapter = makeAcpAdapter(codexAcpConfig);
