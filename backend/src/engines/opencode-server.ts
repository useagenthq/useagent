import { Daytona, type Sandbox } from "@daytona/sdk";
import type { EmitStep, EngineAdapter, EngineRunContext } from "./types";
import { basename, parseJsonLine, truncate } from "./util";

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

/** Parse one SSE frame's data payload (we only care about `data:` lines). */
function sseData(frame: string): Record<string, unknown> | null {
  const dataLines = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return null;
  return parseJsonLine(dataLines.join(""));
}

export const opencodeServerAdapter: EngineAdapter = {
  id: "opencode",

  async run(ctx: EngineRunContext): Promise<void> {
    const apiKey = process.env.DAYTONA_API_KEY;
    if (!apiKey) throw new Error("opencode engine needs DAYTONA_API_KEY in the backend env");
    const startedAt = Date.now();
    const daytona = new Daytona({ apiKey, target: process.env.DAYTONA_TARGET ?? "us" });
    const budgetMs = Number(process.env.ENGINE_TIMEOUT_MS ?? 180_000);

    const envVars: Record<string, string> = {};
    if (process.env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (process.env.OPENROUTER_API_KEY) envVars.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

    const snapshot = process.env.DAYTONA_SNAPSHOT ?? "skynet-agent-v17";
    let sandbox: Sandbox | null = null;
    let npxFallback = false;
    let retainForThread = false;
    let succeeded = false;

    try {
      // ── sandbox: reuse the thread's, else provision ─────────────────────────
      const remembered = ctx.threadId ? threadServers.get(ctx.threadId) : undefined;
      if (remembered) {
        try {
          const prior = await daytona.get(remembered.sandboxId);
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

      // ── persistent server + preview endpoint ────────────────────────────────
      const { baseUrl, token, workdir } = await ensureServer(sandbox, npxFallback);
      if (ctx.threadId) {
        threadServers.set(ctx.threadId, { sandboxId: sandbox.id, baseUrl, token });
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

      // ── realtime: subscribe /event BEFORE prompting ─────────────────────────
      const sseAbort = new AbortController();
      const onParentAbort = () => sseAbort.abort();
      ctx.signal.addEventListener("abort", onParentAbort, { once: true });

      // Live translation state: text deltas by part id; tool steps by part id.
      const textLen = new Map<string, number>();
      const textParts = new Map<string, string>(); // ordered final text parts
      const toolSteps = new Map<string, string>(); // part id → persisted step id
      const toolDone = new Set<string>();

      const handlePart = async (part: Record<string, unknown>): Promise<void> => {
        if (part.sessionID !== sessionId) return;
        const partId = String(part.id ?? "");
        if (part.type === "text" && typeof part.text === "string") {
          const prev = textLen.get(partId) ?? 0;
          if (part.text.length > prev) {
            ctx.publishDelta?.(part.text.slice(prev));
            textLen.set(partId, part.text.length);
          }
          textParts.set(partId, part.text);
          return;
        }
        if (part.type === "tool" && typeof part.tool === "string") {
          const st = (part.state ?? {}) as {
            status?: string;
            input?: Record<string, unknown>;
            output?: string;
            title?: string;
          };
          if (toolDone.has(partId)) return;
          if (!toolSteps.has(partId) && (st.status === "running" || st.status === "completed" || st.status === "error")) {
            const id = await ctx.emit(toolStep(part.tool, st.input ?? {}, st.title, undefined));
            if (id) toolSteps.set(partId, id);
          }
          if ((st.status === "completed" || st.status === "error") && toolSteps.has(partId)) {
            toolDone.add(partId);
            await ctx.updateStep?.(toolSteps.get(partId)!, {
              tool: part.tool,
              input: st.input ?? {},
              output: (st.output ?? "").slice(0, 2000),
            });
          }
        }
      };

      const pumpEvents = async (): Promise<void> => {
        const res = await fetch(`${baseUrl}/event`, {
          headers: authHeaders(token),
          signal: sseAbort.signal,
        });
        if (!res.ok || !res.body) return;
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk as Uint8Array, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const ev = sseData(frame);
            if (!ev) continue;
            const props = (ev.properties ?? {}) as { part?: Record<string, unknown> };
            if (ev.type === "message.part.updated" && props.part) await handlePart(props.part);
          }
        }
      };
      const pump = pumpEvents().catch(() => {}); // SSE is additive; REST is truth

      // ── the turn: POST resolves when the assistant message completes ────────
      await ctx.emit({ kind: "task", label: "Running opencode (server)…", chip: "opencode" });
      const model = ctx.model?.trim() || DEFAULT_MODEL;
      const turnAbort = new AbortController();
      const timer = setTimeout(() => turnAbort.abort(), Math.max(10_000, budgetMs - (Date.now() - startedAt)));
      const onAbort2 = () => turnAbort.abort();
      ctx.signal.addEventListener("abort", onAbort2, { once: true });

      const postPrompt = async (text: string): Promise<Response> =>
        fetch(`${baseUrl}/session/${sessionId}/message${dirQ}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: modelBody(model),
            parts: [{ type: "text", text }],
          }),
          signal: turnAbort.signal,
        });

      let reply: { parts?: { type?: string; text?: string }[] };
      try {
        let res = await postPrompt(resumed ? ctx.prompt : ctx.contextPreamble + ctx.prompt);
        if (res.status === 404 && resumed) {
          // Stale resume id (session from a previous sandbox/server incarnation)
          // — start fresh WITH the composed preamble, exactly like the CLI path.
          sessionId = await createSession();
          resumed = false;
          res = await postPrompt(ctx.contextPreamble + ctx.prompt);
        }
        if (!res.ok) {
          throw new Error(`opencode prompt failed: HTTP ${res.status} ${truncate(await res.text(), 200)}`);
        }
        reply = (await res.json()) as typeof reply;
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
        ctx.signal.removeEventListener("abort", onParentAbort);
        await pump;
      }

      // ── finalize from the AUTHORITATIVE completed reply ─────────────────────
      // Tool parts the SSE pump missed (rejected stream, late frames after the
      // drain window) are reconciled here so the durable log never depends on
      // the pump having stayed healthy.
      for (const p of (reply.parts ?? []) as Record<string, unknown>[]) {
        if (p.type !== "tool" || typeof p.tool !== "string") continue;
        const partId = String(p.id ?? "");
        if (partId && toolSteps.has(partId)) continue; // already streamed live
        const st = (p.state ?? {}) as {
          input?: Record<string, unknown>;
          output?: string;
          title?: string;
        };
        await ctx.emit(toolStep(p.tool, st.input ?? {}, st.title, (st.output ?? "").slice(0, 2000)));
      }
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
      if (sandbox && (!retainForThread || !succeeded)) {
        if (ctx.threadId) threadServers.delete(ctx.threadId);
        await sandbox.delete().catch(() => {});
      }
    }
  },
};
