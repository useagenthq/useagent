// Ported from reference bot (Apache-2.0): src/kiro_crew/acp/client.py
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmitStep, EngineAdapter, EngineRunContext } from "./types";
import { basename, childEnv, parseJsonLine, readLines, truncate } from "./util";

// ---------------------------------------------------------------------------
// ACP (Agent Client Protocol) adapter — ONE generic engine that speaks
// JSON-RPC 2.0 over stdio to any ACP agent. We drive Claude Code through the
// public bridge `@agentclientprotocol/claude-agent-acp` → `@anthropic-ai/
// claude-agent-sdk` → the user's `claude` CLI, with no kiro/AWS login. This is
// the reference bot `REFERENCE_BOT_FORCE_CLAUDE_ACP` blueprint, ported to our engine
// contract; the agent behind ACP is swappable purely via env.
//
// Wire protocol (verified against the installed bridge + @agentclientprotocol/sdk):
//   → initialize          { protocolVersion:1, clientCapabilities }
//   → session/new         { cwd, mcpServers:[] }                → { sessionId }
//   → session/prompt      { sessionId, prompt:[{type:"text",text}] } → { stopReason }
//   ← session/update      notifications: agent_message_chunk / tool_call /
//                         tool_call_update → our command/file/task steps
//   ← session/request_permission (server→client REQUEST) → we ALWAYS approve
//                         (engines are yolo-only by policy).
//
// Config (env):
//   ACP_BRIDGE_BIN   — explicit bridge entry (a .js is wrapped with node).
//   ACP_CLAUDE_BIN   — the `claude` CLI the bridge drives (default: the local
//                      ~/.local/bin/claude, else `claude` on PATH). Forwarded as
//                      CLAUDE_CODE_EXECUTABLE, which the bridge passes to the SDK
//                      as pathToClaudeCodeExecutable.
//
// Yolo wiring: the bridge starts a claude session in the permission mode from
// <cwd>/.claude/settings*.json. The SDK's trust filter strips an escalating
// `defaultMode` from the repo-committed settings.json but HONORS it from the
// gitignored `settings.local.json` (local tier), so we seed THAT with
// `bypassPermissions` — the session then auto-executes every tool with no
// permission round-trip. The always-approve `session/request_permission`
// handler below is the belt-and-suspenders fallback (e.g. bypass disabled when
// running as root), so the run never blocks on a prompt regardless.
// ---------------------------------------------------------------------------

/** Public npm bridge, installed locally (npm -g is broken on this machine). */
const LOCAL_BRIDGE_PKG =
  "/tmp/reference-bot-patch/npm/node_modules/@agentclientprotocol/claude-agent-acp";

/** Resolve the argv that launches the ACP bridge child process. */
function resolveBridgeArgv(): string[] {
  const override = process.env.ACP_BRIDGE_BIN;
  if (override) return override.endsWith(".js") ? ["node", override] : [override];

  // Local install: read its package.json `bin` to find the Node entry script.
  const pkgPath = join(LOCAL_BRIDGE_PKG, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        bin?: string | Record<string, string>;
      };
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["claude-agent-acp"];
      const entry = rel ? join(LOCAL_BRIDGE_PKG, rel) : "";
      if (entry && existsSync(entry)) return ["node", entry];
    } catch {
      /* fall through to bunx */
    }
  }

  // Bun-only fallback: fetch + run the published bridge on demand.
  return ["bunx", "@agentclientprotocol/claude-agent-acp"];
}

/** The concrete `claude` CLI the bridge should drive (CLAUDE_CODE_EXECUTABLE). */
function resolveClaudeBin(): string {
  const override = process.env.ACP_CLAUDE_BIN;
  if (override) return override;
  const local = join(homedir(), ".local", "bin", "claude");
  return existsSync(local) ? local : "claude";
}

/** Seed <workdir>/.claude/settings.local.json so the bridge starts yolo. */
function seedBypassPermissions(workdir: string): void {
  const dir = join(workdir, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "settings.local.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
  );
}

interface JsonRpcMsg {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  params?: unknown;
}

/** A tool call accumulated across its `tool_call` + `tool_call_update` frames.
 *  ACP reports a tool once as `tool_call` (input) then again as
 *  `tool_call_update` (status/output); we merge and emit ONE step on the
 *  terminal status — the same "emit once per tool" discipline as codex.ts. */
interface ToolRecord {
  kind?: string;
  title?: string;
  rawInput?: unknown;
  output?: string;
  status?: string;
  flushed: boolean; // preceding narration already flushed as a task step
  emitted: boolean; // terminal step already emitted
}

/** Text of a bridge JSON-RPC error, compact for a step/exception label. */
function rpcErrorText(error: JsonRpcMsg["error"]): string {
  if (!error) return "acp error";
  const data = typeof error.data === "string" ? error.data : "";
  return truncate(`${error.message ?? "acp error"}${data ? `: ${data}` : ""}`, 200);
}

/** Text output out of a tool call's ACP `content` blocks / `rawOutput`. */
function extractOutput(content: unknown, rawOutput: unknown): string {
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as { type?: string; content?: { type?: string; text?: string } };
      if (b?.type === "content" && b.content?.type === "text" && b.content.text) {
        parts.push(b.content.text);
      }
    }
    if (parts.length) return parts.join("\n").slice(0, 2000);
  }
  if (typeof rawOutput === "string") return rawOutput.slice(0, 2000);
  if (rawOutput && typeof rawOutput === "object") {
    try {
      return JSON.stringify(rawOutput).slice(0, 2000);
    } catch {
      /* non-serializable — ignore */
    }
  }
  return "";
}

export const acpAdapter: EngineAdapter = {
  id: "acp",

  async run(ctx: EngineRunContext): Promise<void> {
    const startedAt = Date.now();
    seedBypassPermissions(ctx.workdir);

    const env = childEnv(ctx.workdir);
    env.CLAUDE_CODE_EXECUTABLE = resolveClaudeBin();

    const proc = Bun.spawn(resolveBridgeArgv(), {
      cwd: ctx.workdir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
      signal: ctx.signal,
    });

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const writeFrame = (obj: unknown): void => {
      try {
        proc.stdin.write(encoder.encode(`${JSON.stringify(obj)}\n`));
        proc.stdin.flush();
      } catch {
        /* stdin closed (child gone) — the exit handler rejects pending calls */
      }
    };

    // Outbound JSON-RPC request/response correlation by numeric id.
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const sendRequest = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        writeFrame({ jsonrpc: "2.0", id, method, params });
      });

    // Step-translation state.
    let pendingText = ""; // current assistant text block being streamed
    let summaryText = ""; // last flushed block → the run summary
    const tools = new Map<string, ToolRecord>();

    const flushText = async (): Promise<void> => {
      const t = pendingText.trim();
      pendingText = "";
      if (!t) return;
      summaryText = t;
      await ctx.emit({ kind: "task", label: truncate(t, 60), chip: "task" });
    };

    const stepForTool = (rec: ToolRecord): EmitStep => {
      const input = (rec.rawInput ?? {}) as Record<string, unknown>;
      if (rec.kind === "execute") {
        const cmd = (input.command as string) ?? rec.title ?? "command";
        return {
          kind: "command",
          label: truncate(String(cmd)),
          chip: "bash",
          code_json: { command: cmd, output: rec.output ?? "" },
        };
      }
      if (rec.kind === "edit" || rec.kind === "delete" || rec.kind === "move") {
        const path =
          (input.path as string) ?? (input.file_path as string) ?? (input.filePath as string) ?? "";
        const label = path ? basename(path) : rec.title ?? "file change";
        return {
          kind: "file",
          label: truncate(String(label)),
          chip: "file",
          code_json: { kind: rec.kind, path, input },
        };
      }
      // read / search / fetch / think / other — surface as activity so the
      // trace shows what the agent did (label from the agent's own title).
      return {
        kind: "command",
        label: truncate(String(rec.title ?? rec.kind ?? "tool")),
        chip: rec.kind ?? "tool",
        code_json: { kind: rec.kind, input, output: rec.output ?? "" },
      };
    };

    const handleToolUpdate = async (u: Record<string, unknown>): Promise<void> => {
      const id = u.toolCallId as string | undefined;
      if (!id) return;
      const rec: ToolRecord = tools.get(id) ?? { flushed: false, emitted: false };
      if (u.kind != null) rec.kind = u.kind as string;
      if (u.title != null) rec.title = u.title as string;
      if (u.rawInput != null) rec.rawInput = u.rawInput;
      const out = extractOutput(u.content, u.rawOutput);
      if (out) rec.output = out;
      if (u.status != null) rec.status = u.status as string;
      tools.set(id, rec);

      // A tool marks the end of the preceding narration block — flush it first
      // so steps read in natural order (narration, then the tool).
      if (!rec.flushed) {
        rec.flushed = true;
        await flushText();
      }
      if ((rec.status === "completed" || rec.status === "failed") && !rec.emitted) {
        rec.emitted = true;
        await ctx.emit(stepForTool(rec));
      }
    };

    const handleNotification = async (msg: JsonRpcMsg): Promise<void> => {
      if (msg.method !== "session/update") return;
      const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
      if (!update) return;
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const content = update.content as { type?: string; text?: string } | undefined;
          const text = content?.type === "text" ? content.text ?? "" : "";
          if (text) {
            pendingText += text;
            ctx.publishDelta?.(text);
          }
          break;
        }
        case "tool_call":
        case "tool_call_update":
          await handleToolUpdate(update);
          break;
        default:
          // agent_thought_chunk / plan / usage_update / … — not surfaced.
          break;
      }
    };

    const handleServerRequest = (msg: JsonRpcMsg): void => {
      if (msg.method === "session/request_permission") {
        // Yolo: always approve. Prefer a one-shot allow, then allow-always,
        // then whatever option exists; cancel only if none advertised.
        const options =
          (msg.params as { options?: Array<{ optionId: string; kind: string }> } | undefined)
            ?.options ?? [];
        const pick =
          options.find((o) => o.kind === "allow_once") ??
          options.find((o) => o.kind === "allow_always") ??
          options[0];
        writeFrame({
          jsonrpc: "2.0",
          id: msg.id,
          result: pick
            ? { outcome: { outcome: "selected", optionId: pick.optionId } }
            : { outcome: { outcome: "cancelled" } },
        });
        return;
      }
      // Any other server→client request (fs/*, terminal/*) — we serve none, so
      // answer method-not-found rather than leave the agent hanging on it.
      writeFrame({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Method not found" },
      });
    };

    // Drain stderr so the child never blocks on a full pipe; keep a tail for
    // error messages.
    let stderrTail = "";
    void (async () => {
      try {
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
          stderrTail = (stderrTail + decoder.decode(chunk)).slice(-2000);
        }
      } catch {
        /* stream closed */
      }
    })();

    // Fail every in-flight request if the bridge dies (crash or abort-kill),
    // so the handshake/prompt never hangs.
    void proc.exited.then((code) => {
      if (pending.size === 0) return;
      const err = new Error(
        `acp bridge exited (code ${code})${stderrTail.trim() ? `: ${truncate(stderrTail, 200)}` : ""}`,
      );
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(err);
      }
    });

    // Single reader loop: demux responses / server-requests / notifications.
    const readerDone = (async () => {
      try {
        for await (const line of readLines(proc.stdout)) {
          const msg = parseJsonLine(line) as JsonRpcMsg | null;
          if (!msg) continue;
          if (msg.method === undefined && msg.id !== undefined) {
            // Response to one of our requests.
            const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
            if (p && typeof msg.id === "number") {
              pending.delete(msg.id);
              if (msg.error) p.reject(new Error(rpcErrorText(msg.error)));
              else p.resolve(msg.result);
            }
          } else if (msg.method !== undefined && msg.id !== undefined) {
            handleServerRequest(msg); // server→client request (permission)
          } else if (msg.method !== undefined) {
            await handleNotification(msg); // notification (session/update)
          }
        }
      } catch {
        /* stdout closed mid-read (child killed) */
      }
    })();

    try {
      await sendRequest("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      if (ctx.signal.aborted) throw new Error("acp run aborted (timeout)");

      const created = (await sendRequest("session/new", {
        cwd: ctx.workdir,
        mcpServers: [],
      })) as { sessionId?: string } | undefined;
      const sessionId = created?.sessionId;
      if (!sessionId) throw new Error("acp session/new returned no sessionId");

      await sendRequest("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: ctx.contextPreamble + ctx.prompt }],
      });
      if (ctx.signal.aborted) throw new Error("acp run aborted (timeout)");

      await flushText();
      await ctx.emit({ kind: "done", label: "Done", chip: null });
      ctx.setSummary(summaryText.trim() || "acp run completed", Date.now() - startedAt);
    } finally {
      try {
        proc.stdin.end();
      } catch {
        /* already closed */
      }
      proc.kill();
      await readerDone.catch(() => {});
    }
  },
};
