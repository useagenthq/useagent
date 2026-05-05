import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Daytona, type Sandbox } from "@daytona/sdk";
import type { EmitStep, EngineAdapter, EngineRunContext } from "./types";
import { basename, parseJsonLine, truncate } from "./util";

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
const CODEX_ACP_PKG = "@agentclientprotocol/codex-acp@0.16.0";
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

interface AcpEngineConfig {
  id: "claude" | "codex";
  port: number;
  /** npm packages installed once per sandbox (user prefix); `bin` is the
   *  installed binary probed for idempotency (differs from the package name). */
  packages: { pkg: string; bin: string }[];
  /** Relay child command (resolved on the sandbox PATH incl. ~/.local/bin). */
  agentCmd: string[];
  /** Extra env exported before the relay starts. */
  agentEnv?: Record<string, string>;
  /** Idempotent per-turn sandbox prep (codex auth seeding). */
  prepare?(sandbox: Sandbox): Promise<void>;
}

interface ThreadRelay {
  sandboxId: string;
  baseUrl: string;
  token: string;
  workdir: string;
  /** ACP session id LIVE in the current agent process (also persisted to the
   *  DB; a dead process/sandbox invalidates it and we session/new again). */
  sessionId: string | null;
}

/** threadId → per-engine relay state (a thread talks to ONE engine's relay). */
const threadRelays = new Map<string, ThreadRelay>();

const relayKey = (threadId: string, engine: string): string => `${engine}:${threadId}`;

function authHeaders(token: string): Record<string, string> {
  return { "x-daytona-preview-token": token };
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
      const budgetMs = Number(process.env.ENGINE_TIMEOUT_MS ?? 180_000);

      const envVars: Record<string, string> = {};
      if (process.env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

        await cfg.prepare?.(box);

        // ── resident agent: install once, relay up, resolve endpoint ────────
        const probeCmd = `curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:${cfg.port}/health`;
        const relayB64 = Buffer.from(RELAY_SCRIPT, "utf8").toString("base64");
        const agentEnvExports = Object.entries(cfg.agentEnv ?? {})
          .map(([k, v]) => `export ${k}="${v}"; `)
          .join("");
        const boot = await box.process.executeCommand(
          `export PATH=$HOME/.local/bin:$PATH; mkdir -p ~/work; ` +
            // Install the agent package(s) once per sandbox.
            cfg.packages
              .map(
                ({ pkg, bin }) =>
                  `command -v ${bin} >/dev/null 2>&1 || npm install -g --prefix $HOME/.local --silent "${pkg}" >/dev/null 2>&1; `,
              )
              .join("") +
            // Stage the relay + start it if not already answering.
            `printf '%s' '${relayB64}' | base64 -d > ~/acp-relay.mjs; ` +
            `if [ "$(${probeCmd})" = "000" ]; then ` +
            `${agentEnvExports}cd ~/work && nohup node ~/acp-relay.mjs ${cfg.port} ${cfg.agentCmd.join(" ")} > /tmp/acp-relay-${cfg.id}.log 2>&1 & ` +
            `fi; ` +
            `up=0; for i in $(seq 1 30); do [ "$(${probeCmd})" != "000" ] && up=1 && break; sleep 1; done; ` +
            `if [ "$up" = "1" ]; then echo "HOME=$HOME"; exit 0; fi; ` +
            `echo BOOT-TIMEOUT; tail -c 400 /tmp/acp-relay-${cfg.id}.log; exit 1`,
          undefined,
          undefined,
          300,
        );
        if ((boot.exitCode ?? 1) !== 0) {
          throw new Error(`${cfg.id} ACP relay failed to boot: ${truncate(boot.result ?? "", 200)}`);
        }
        const home = /HOME=(\S+)/.exec(boot.result ?? "")?.[1] ?? "/home/daytona";

        if (!relay) {
          const link = await box.getPreviewLink(cfg.port);
          relay = {
            sandboxId: box.id,
            baseUrl: link.url.replace(/\/+$/, ""),
            token: link.token ?? "",
            workdir: `${home}/work`,
            sessionId: null,
          };
        }
        const live = relay; // narrowed non-null for the closures below
        if (key) {
          threadRelays.set(key, live);
          retainForThread = true;
        }

        // ── JSON-RPC client over the relay (SSE in, POST out) ───────────────
        const sseAbort = new AbortController();
        const onParentAbort = () => sseAbort.abort();
        ctx.signal.addEventListener("abort", onParentAbort, { once: true });

        let nextId = 1;
        const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();

        const post = async (msg: Record<string, unknown>): Promise<void> => {
          const res = await fetch(`${live.baseUrl}/send`, {
            method: "POST",
            headers: { ...authHeaders(live.token), "content-type": "application/json" },
            body: JSON.stringify(msg),
            signal: sseAbort.signal,
          });
          if (!res.ok && res.status !== 204) throw new Error(`relay send failed: HTTP ${res.status}`);
        };
        const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
          const id = nextId++;
          const p = new Promise<Record<string, unknown>>((resolve, reject) => {
            pending.set(id, { resolve, reject });
          });
          void post({ jsonrpc: "2.0", id, method, params }).catch((e) => {
            pending.get(id)?.reject(e as Error);
            pending.delete(id);
          });
          return p;
        };

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
              // Response to one of our requests.
              if (typeof msg.id === "number" && ("result" in msg || "error" in msg) && pending.has(msg.id)) {
                const waiter = pending.get(msg.id)!;
                pending.delete(msg.id);
                if (msg.error) {
                  waiter.reject(new Error(`ACP ${JSON.stringify(msg.error).slice(0, 200)}`));
                } else {
                  waiter.resolve((msg.result ?? {}) as Record<string, unknown>);
                }
                continue;
              }
              // Server → client REQUEST (permissions): always approve — engines
              // run yolo-only in the isolated sandbox, same policy as the CLIs.
              if (typeof msg.id === "number" && msg.method === "session/request_permission") {
                const params = (msg.params ?? {}) as { options?: { optionId?: string; kind?: string }[] };
                const opts = params.options ?? [];
                const allow =
                  opts.find((o) => o.kind === "allow_always") ??
                  opts.find((o) => o.kind === "allow_once") ??
                  opts[0];
                void post({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { outcome: { outcome: "selected", optionId: allow?.optionId ?? "allow" } },
                }).catch(() => {});
                continue;
              }
              // Notifications.
              if (msg.method === "session/update") {
                await handleUpdate((msg.params ?? {}) as Record<string, unknown>);
              }
            }
          }
        })().catch(() => {});

        // Wait for the SSE to actually attach before any request (the relay
        // broadcasts only to connected clients — no replay).
        await new Promise((r) => setTimeout(r, 300));

        // ── ACP handshake + the turn ────────────────────────────────────────
        const turnTimeout = setTimeout(() => sseAbort.abort(), Math.max(10_000, budgetMs - (Date.now() - startedAt)));
        try {
          await request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          });

          // Session: live in-process one wins; else try loading the persisted
          // id; else a fresh session (with the composed preamble).
          let sessionId = live.sessionId;
          let resumed = Boolean(sessionId);
          if (!sessionId && ctx.engineSessionId) {
            try {
              await request("session/load", {
                sessionId: ctx.engineSessionId,
                cwd: live.workdir,
                mcpServers: [],
              });
              sessionId = ctx.engineSessionId;
              resumed = true;
            } catch {
              sessionId = null; // agent can't load it (fresh process/no support)
            }
          }
          if (!sessionId) {
            const res = await request("session/new", { cwd: live.workdir, mcpServers: [] });
            sessionId = String(res.sessionId ?? "");
            if (!sessionId) throw new Error("ACP session/new returned no sessionId");
            resumed = false;
          }
          live.sessionId = sessionId;
          ctx.saveEngineSessionId?.(sessionId);

          await ctx.emit({ kind: "task", label: `Running ${cfg.id} (resident)…`, chip: cfg.id });
          const promptText = resumed ? ctx.prompt : ctx.contextPreamble + ctx.prompt;
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

export const acpClaudeAdapter = makeAcpAdapter({
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
});

export const acpCodexAdapter = makeAcpAdapter({
  id: "codex",
  port: 4098,
  packages: [{ pkg: CODEX_ACP_PKG, bin: "codex-acp" }],
  agentCmd: ["codex-acp"],
  // Codex authenticates via the seeded ChatGPT-login credential (no API key).
  prepare: async (sandbox) => {
    let auth: string;
    try {
      auth = readFileSync(join(homedir(), ".codex", "auth.json"), "utf8");
    } catch {
      throw new Error(
        "codex engine needs ~/.codex/auth.json on the host (run `codex login`) — no OPENAI_API_KEY is configured",
      );
    }
    const b64 = Buffer.from(auth, "utf8").toString("base64");
    const res = await sandbox.process.executeCommand(
      `mkdir -p ~/.codex && printf '%s' '${b64}' | base64 -d > ~/.codex/auth.json && chmod 600 ~/.codex/auth.json`,
      undefined,
      undefined,
      30,
    );
    if ((res.exitCode ?? 1) !== 0) throw new Error("failed to seed codex auth into sandbox");
  },
});
