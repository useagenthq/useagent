import { Daytona, type Sandbox } from "@daytona/sdk";
import type { EmitStep, EngineAdapter, EngineRunContext } from "./types";
import { basename, parseJsonLine, truncate } from "./util";
import { getThreadSandbox, setRunSandbox } from "../runs/repo";

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
    const budgetMs = Number(process.env.ENGINE_TIMEOUT_MS ?? 600_000);

    const envVars: Record<string, string> = {};
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

      // Durable thread→sandbox mapping: the DB row survives restarts (the
      // in-memory map is just a cache for the preview endpoint).
      void setRunSandbox(ctx.runId, sandbox.id).catch(() => {});

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
      // Resumed turns must ALSO stamp the id on THEIR run row — a thread whose
      // only stamped run gets deleted (or a race) would otherwise go dark for
      // the Live tab even though the session exists.
      else ctx.saveEngineSessionId?.(sessionId);

      // ── realtime: subscribe /event BEFORE prompting ─────────────────────────
      const sseAbort = new AbortController();
      const onParentAbort = () => sseAbort.abort();
      ctx.signal.addEventListener("abort", onParentAbort, { once: true });

      // Live translation state: text deltas by part id; tool steps by part id.
      // Subagents run in CHILD sessions (parentID chains to ours) — track them so
      // their tool activity renders (↳-tagged) instead of being filtered out.
      const childSessions = new Set<string>();
      const textLen = new Map<string, number>();
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
          const text = typeof part.text === "string" ? (part.text as string) : "";
          if (typeof delta === "string" && delta.length > 0) {
            ctx.publishDelta?.(delta);
            textLen.set(partId, text.length);
          } else {
            const prev = textLen.get(partId) ?? 0;
            if (text.length > prev) {
              ctx.publishDelta?.(text.slice(prev));
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
            code_json: { agent: p.agent, description: p.description, prompt: p.prompt },
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
              if (isChild) step.label = `↳ ${step.label}`;
              if (isTask) emittedSubagents.add(taskDesc);
              const id = await ctx.emit(step);
              if (id) toolSteps.set(partId, id);
            }
          }
          if ((status === "completed" || status === "error") && toolSteps.has(partId)) {
            toolDone.add(partId);
            const output = status === "error" ? String(st.error ?? "") : String(st.output ?? "");
            await ctx.updateStep?.(toolSteps.get(partId)!, {
              tool: part.tool,
              input: st.input ?? {},
              output: output.slice(0, 2000),
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
              info?: { id?: string; parentID?: string };
            };
            // Register subagent sessions: any session whose parent chains to ours
            // (direct child OR a child of an already-tracked child).
            if (
              (ev.type === "session.created" || ev.type === "session.updated") &&
              props.info?.id &&
              props.info.parentID &&
              (props.info.parentID === sessionId || childSessions.has(props.info.parentID))
            ) {
              childSessions.add(props.info.id);
            }
            if (ev.type === "message.part.updated" && props.part) {
              await handlePart(props.part, typeof props.delta === "string" ? props.delta : undefined);
            }
          }
        }
      };
      const pump = pumpEvents().catch(() => {}); // SSE is additive; REST is truth

      // ── the turn: POST resolves when the assistant message completes ────────
      await ctx.emit({ kind: "task", label: "Thinking…", chip: "opencode" });
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
          const msgs = (await res.json()) as { parts?: Record<string, unknown>[] }[];
          for (const m of msgs) {
            for (const part of m.parts ?? []) {
              if (part.type === "tool" || part.type === "subtask") await handlePart(part);
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
        if (cres.ok) for (const c of (await cres.json()) as { id?: string }[]) if (c.id) childSessions.add(c.id);
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
