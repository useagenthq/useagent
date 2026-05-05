import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Daytona, type Sandbox } from "@daytona/sdk";
import type { EmitStep, EngineAdapter, EngineRunContext } from "./types";
import { basename, parseJsonLine, truncate } from "./util";

// ---------------------------------------------------------------------------
// Sandbox engine substrate — ALL user-facing engines (opencode / claude / codex)
// execute inside a per-THREAD Daytona cloud sandbox; local engine execution is
// deliberately gone. One shared runner owns the sandbox lifecycle (create /
// thread-reuse / resume / teardown), prompt staging, the blocking exec (the
// session-command streaming API starves against real sandboxes — verified live),
// and exit policy. Each engine contributes a small spec: how to build its
// command, how to translate its JSONL, and how its native session id is
// captured/resumed — the reference bot model (explicit ids, persisted in the runs
// table via ctx.saveEngineSessionId, resumed via ctx.engineSessionId).
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-opus-5";
/** Pinned versions for npx-on-demand installs inside the sandbox (the default
 *  image has no engines preinstalled; the `skynet-agent` snapshot, when active,
 *  has opencode on PATH). */
const OPENCODE_VERSION = "1.18.7";
const CLAUDE_CODE_VERSION = "2.1.222";
const CODEX_VERSION = "0.146.0";

/** Where each turn's prompt is staged inside the sandbox (fed to the CLI via
 *  stdin redirect — see SandboxEngineSpec.command). */
const PROMPT_PATH = "/tmp/skynet-prompt.txt";

const FILE_TOOLS_OPENCODE = new Set(["write", "edit", "patch", "multiedit"]);
const FILE_TOOLS_CLAUDE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** One live sandbox per conversation. In-memory (a restart re-provisions);
 *  cost containment lives on the sandbox: 10m idle auto-stop + 2h auto-delete. */
const threadSandboxes = new Map<string, { sandboxId: string; npxFallback: boolean }>();

/** Mutable per-run parse state shared between the runner and a spec's line handler. */
interface ParseState {
  lastText: string;
  rawTail: string;
  seenTools: Set<string>;
  sessionId: string | null;
}

interface SandboxEngineSpec {
  /** Engine id as registered (also the step chip). */
  id: string;
  /** Shell command for one turn. The runner feeds the staged prompt via STDIN
   *  (`< /tmp/skynet-prompt.txt`) — never as a positional argument, because a
   *  prompt whose first line starts with `---` (the team-memory block header)
   *  parses as a flag and kills the CLI with a usage error. All three engines
   *  read a piped prompt (verified live). */
  command(args: {
    model: string;
    resumeId: string | undefined;
    npxFallback: boolean;
  }): string;
  /** Translate one stdout line; return a step to emit (or null). Must also
   *  maintain state.lastText / state.sessionId as its protocol reveals them. */
  handleLine(line: string, state: ParseState): EmitStep | null;
  /** Extra sandbox preparation (e.g. codex auth seeding). Runs after create AND
   *  after reuse — must be idempotent and cheap. */
  prepare?(sandbox: Sandbox): Promise<void>;
}

/** Map a bare Anthropic-style model id to opencode's provider/model format. */
function opencodeModel(model: string): string {
  return model.includes("/") ? `openrouter/${model}` : `anthropic/${model}`;
}

/** Track the last MEANINGFUL non-JSON line for error surfacing. npm's install
 *  chatter ("npm notice …") prints AFTER a CLI's real error and would mask it. */
function noteRawLine(line: string, state: ParseState): void {
  const t = line.trim();
  if (!t || t.startsWith("npm notice") || t.startsWith("npm warn")) return;
  state.rawTail = truncate(t, 200);
}

/** Pull a session id out of a parsed event, defensively across engines. */
function anySessionId(ev: Record<string, unknown>): string | null {
  for (const key of ["sessionID", "session_id", "thread_id", "conversation_id"]) {
    const v = ev[key];
    if (typeof v === "string" && v.length > 0) return v;
    const nested = (ev as { part?: Record<string, unknown> }).part?.[key];
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return null;
}

// ── opencode spec (JSONL: step_start / text / tool_use / step_finish) ────────

const opencodeSpec: SandboxEngineSpec = {
  id: "opencode",
  command: ({ model, resumeId, npxFallback }) => {
    const bin = npxFallback ? `npx -y opencode-ai@${OPENCODE_VERSION}` : "opencode";
    const resume = resumeId ? `-s ${resumeId} ` : "";
    return `${bin} run --format json ${resume}-m ${opencodeModel(model)}`;
  },
  handleLine: (line, state) => {
    const ev = parseJsonLine(line);
    if (!ev) {
      noteRawLine(line, state);
      return null;
    }
    if (!state.sessionId) state.sessionId = anySessionId(ev);
    const part = ev.part as
      | {
          type?: string;
          text?: string;
          tool?: string;
          callID?: string;
          state?: { status?: string; title?: string; input?: Record<string, unknown>; output?: string };
        }
      | undefined;
    if (ev.type === "text" && part?.text?.trim()) {
      state.lastText = part.text;
      return { kind: "task", label: truncate(part.text, 60), chip: "task" };
    }
    if (ev.type === "tool_use" && part?.tool) {
      const status = part.state?.status;
      if (status !== "completed" && status !== "error") return null;
      const callId = part.callID ?? `${part.tool}:${state.lastText.length}`;
      if (state.seenTools.has(callId)) return null;
      state.seenTools.add(callId);
      const isFile = FILE_TOOLS_OPENCODE.has(part.tool.toLowerCase());
      const input = part.state?.input ?? {};
      const filePath = (input.filePath as string) ?? (input.file_path as string) ?? "";
      const label = isFile
        ? filePath
          ? basename(filePath)
          : part.state?.title ?? part.tool
        : (input.command as string) ?? part.state?.title ?? part.tool;
      return {
        kind: isFile ? "file" : "command",
        label: truncate(String(label)),
        chip: isFile ? "file" : part.tool === "bash" ? "bash" : part.tool,
        code_json: { tool: part.tool, input, output: (part.state?.output ?? "").slice(0, 2000) },
      };
    }
    return null;
  },
};

// ── claude spec (claude CLI stream-json: system/init, assistant, result) ─────

const claudeSpec: SandboxEngineSpec = {
  id: "claude",
  command: ({ resumeId }) => {
    // Model is engine-managed (Anthropic only); the picker applies to opencode.
    const resume = resumeId ? `--resume ${resumeId} ` : "";
    return (
      `npx -y @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} -p ` +
      `${resume}--model ${DEFAULT_MODEL} --output-format stream-json --verbose ` +
      `--dangerously-skip-permissions`
    );
  },
  handleLine: (line, state) => {
    const ev = parseJsonLine(line);
    if (!ev) {
      noteRawLine(line, state);
      return null;
    }
    if (!state.sessionId) state.sessionId = anySessionId(ev);
    if (ev.type === "assistant") {
      const content =
        ((ev as { message?: { content?: unknown[] } }).message?.content ?? []) as {
          type?: string;
          text?: string;
          name?: string;
          input?: Record<string, unknown>;
        }[];
      // One line carries a whole assistant message; surface the FIRST meaningful
      // block as the step (text beats tool for narration ordering).
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          state.lastText = block.text;
          return { kind: "task", label: truncate(block.text, 60), chip: "task" };
        }
        if (block.type === "tool_use" && block.name) {
          const isFile = FILE_TOOLS_CLAUDE.has(block.name);
          const input = block.input ?? {};
          const path = String(input.file_path ?? input.path ?? "");
          const label =
            block.name === "Bash"
              ? truncate(String(input.command ?? "bash"))
              : isFile && path
                ? basename(path)
                : block.name;
          return {
            kind: isFile ? "file" : "command",
            label,
            chip: block.name === "Bash" ? "bash" : isFile ? "file" : block.name,
            code_json: { tool: block.name, input },
          };
        }
      }
      return null;
    }
    if (ev.type === "result") {
      const text = (ev as { result?: string }).result;
      if (typeof text === "string" && text.trim()) state.lastText = text;
      return null; // the runner emits the done step
    }
    return null;
  },
};

// ── codex spec (codex exec --json JSONL; auth seeded from the host) ──────────

const codexSpec: SandboxEngineSpec = {
  id: "codex",
  command: ({ resumeId }) => {
    const sub = resumeId ? `exec resume ${resumeId}` : "exec";
    return (
      `npx -y @openai/codex@${CODEX_VERSION} ${sub} --json --skip-git-repo-check ` +
      `--dangerously-bypass-approvals-and-sandbox`
    );
  },
  handleLine: (line, state) => {
    const ev = parseJsonLine(line);
    if (!ev) {
      noteRawLine(line, state);
      return null;
    }
    if (!state.sessionId) state.sessionId = anySessionId(ev);
    const item = (ev as { item?: Record<string, unknown> }).item;
    if (ev.type === "item.completed" && item) {
      const itemType = item.type as string | undefined;
      if (itemType === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        state.lastText = item.text;
        return { kind: "task", label: truncate(item.text, 60), chip: "task" };
      }
      if (itemType === "command_execution") {
        const cmd = String(item.command ?? "command");
        return {
          kind: "command",
          label: truncate(cmd),
          chip: "bash",
          code_json: {
            command: cmd,
            output: String(item.aggregated_output ?? "").slice(0, 2000),
            exit_code: item.exit_code ?? null,
          },
        };
      }
      if (itemType === "file_change" || itemType === "patch_apply") {
        const changes = (item.changes ?? item.files ?? []) as { path?: string }[];
        const first = Array.isArray(changes) && changes[0]?.path ? basename(String(changes[0].path)) : "files";
        return { kind: "file", label: first, chip: "file", code_json: item };
      }
    }
    return null;
  },
  // Codex has no API-key auth here — seed the host's ChatGPT-login credential
  // into the sandbox (the user's own Daytona org; required for codex to run at
  // all without an OPENAI_API_KEY). Idempotent overwrite each turn.
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
};

// ── the shared runner ────────────────────────────────────────────────────────

function makeSandboxAdapter(spec: SandboxEngineSpec): EngineAdapter {
  return {
    id: spec.id as EngineAdapter["id"],

    async run(ctx: EngineRunContext): Promise<void> {
      const apiKey = process.env.DAYTONA_API_KEY;
      if (!apiKey) throw new Error(`${spec.id} engine needs DAYTONA_API_KEY in the backend env`);
      const startedAt = Date.now();
      const daytona = new Daytona({ apiKey, target: process.env.DAYTONA_TARGET ?? "us" });

      // Engine/provider keys ride as sandbox env — never on the command line.
      const envVars: Record<string, string> = {};
      if (process.env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      if (process.env.OPENROUTER_API_KEY) envVars.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

      const snapshot = process.env.DAYTONA_SNAPSHOT ?? "skynet-agent";
      let sandbox: Sandbox | null = null;
      let npxFallback = false;
      let retainForThread = false;
      let succeeded = false;

      try {
        // Thread reuse: first turn provisions; later turns reuse (resuming an
        // idle-stopped sandbox), keeping ~/work AND the engine's on-disk session
        // store. Stale mappings fall through to a fresh create.
        const remembered = ctx.threadId ? threadSandboxes.get(ctx.threadId) : undefined;
        if (remembered) {
          try {
            const prior = await daytona.get(remembered.sandboxId);
            const state = (prior as { state?: string }).state;
            if (state === "stopped" || state === "paused" || state === "archived") {
              await ctx.emit({
                kind: "task",
                label: `Resuming thread sandbox ${prior.id.slice(0, 8)}…`,
                chip: spec.id,
              });
              await prior.start();
            } else if (state !== "started") {
              throw new Error(`sandbox in unusable state: ${state}`);
            }
            sandbox = prior;
            npxFallback = remembered.npxFallback;
            retainForThread = true;
            await ctx.emit({
              kind: "task",
              label: `Reusing thread sandbox ${prior.id.slice(0, 8)} (workspace persists)`,
              chip: spec.id,
            });
          } catch {
            if (ctx.threadId) threadSandboxes.delete(ctx.threadId);
            sandbox = null;
          }
        }

        if (!sandbox) {
          await ctx.emit({ kind: "task", label: "Provisioning cloud sandbox…", chip: spec.id });
          // Only opencode benefits from the snapshot (its binary is preinstalled
          // there). claude/codex npx-install on the DEFAULT image — verified: the
          // snapshot runs as root, where `claude --dangerously-skip-permissions`
          // refuses to start; the default image (user `daytona`) works.
          if (spec.id === "opencode") {
            try {
              sandbox = await daytona.create({
                snapshot,
                envVars,
                labels: { "skynet-run": ctx.runId },
                autoStopInterval: 10,
                autoDeleteInterval: 120,
              });
            } catch {
              sandbox = null;
            }
          }
          if (!sandbox) {
            sandbox = await daytona.create({
              envVars,
              labels: { "skynet-run": ctx.runId },
              autoStopInterval: 10,
              autoDeleteInterval: 120,
            });
            npxFallback = true;
          }
          await ctx.emit({
            kind: "task",
            label: `Sandbox ${sandbox.id.slice(0, 8)} ready in ${Math.round((Date.now() - startedAt) / 1000)}s`,
            chip: spec.id,
          });
          if (ctx.threadId) {
            threadSandboxes.set(ctx.threadId, { sandboxId: sandbox.id, npxFallback });
            retainForThread = true;
          }
        }
        if (ctx.signal.aborted) throw new Error(`${spec.id} run aborted (timeout)`);

        await spec.prepare?.(sandbox);

        // Explicit native-session resume: id from the DB (previous turn, same
        // engine). Resuming ⇒ the engine holds the history — send ONLY the new
        // prompt; fresh ⇒ composed preamble (team memory + thread fallback).
        const resumeId = ctx.engineSessionId;
        const box = sandbox;
        const budgetSec = Math.floor(Number(process.env.ENGINE_TIMEOUT_MS ?? 180_000) / 1000);

        const stagePrompt = async (text: string): Promise<void> => {
          const b64 = Buffer.from(text, "utf8").toString("base64");
          const res = await box.process.executeCommand(
            `mkdir -p ~/work && printf '%s' '${b64}' | base64 -d > ${PROMPT_PATH}`,
            undefined,
            undefined,
            30,
          );
          if ((res.exitCode ?? 1) !== 0) throw new Error("failed to stage prompt in sandbox");
        };

        // One engine turn: run the CLI with the staged prompt on STDIN, translate
        // its JSONL into steps, persist the session id the moment it appears.
        const execTurn = async (
          resume: string | undefined,
        ): Promise<{ exitCode: number; state: ParseState; produced: boolean }> => {
          const command = spec.command({
            model: ctx.model?.trim() || DEFAULT_MODEL,
            resumeId: resume,
            npxFallback,
          });
          const timeout = Math.max(60, budgetSec - Math.floor((Date.now() - startedAt) / 1000) - 15);
          const result = await box.process.executeCommand(
            `cd ~/work && ${command} < ${PROMPT_PATH} 2>&1`,
            undefined,
            undefined,
            timeout,
          );
          if (ctx.signal.aborted) throw new Error(`${spec.id} run aborted (timeout)`);
          const state: ParseState = { lastText: "", rawTail: "", seenTools: new Set(), sessionId: null };
          for (const line of (result.result ?? "").split("\n")) {
            const step = spec.handleLine(line, state);
            if (step) await ctx.emit(step);
          }
          if (state.sessionId) ctx.saveEngineSessionId?.(state.sessionId);
          const exitCode = result.exitCode ?? 0;
          // 137 = SIGKILL at teardown on the small default image AFTER the work
          // streamed; only fatal when nothing was produced (genuine mid-run OOM).
          const produced = state.lastText.trim().length > 0 || state.seenTools.size > 0;
          return { exitCode, state, produced };
        };

        await stagePrompt(resumeId ? ctx.prompt : ctx.contextPreamble + ctx.prompt);
        await ctx.emit({ kind: "task", label: `Running ${spec.id} in sandbox…`, chip: spec.id });
        let turn = await execTurn(resumeId);
        if (turn.exitCode !== 0 && !(turn.exitCode === 137 && turn.produced)) {
          // A stale resume id (e.g. sandbox filesystem replaced) fails fast with
          // no parsed output — retry ONCE as a fresh session with the preamble.
          if (!(resumeId && !turn.produced)) {
            throw new Error(
              `${spec.id} (in sandbox) exited ${turn.exitCode}: ${turn.state.rawTail || "no output"}`,
            );
          }
          await stagePrompt(ctx.contextPreamble + ctx.prompt);
          turn = await execTurn(undefined);
          if (turn.exitCode !== 0 && !(turn.exitCode === 137 && turn.produced)) {
            throw new Error(
              `${spec.id} (in sandbox) exited ${turn.exitCode}: ${turn.state.rawTail || "no output"}`,
            );
          }
        }

        await ctx.emit({ kind: "done", label: "Done", chip: null });
        ctx.setSummary(
          turn.state.lastText.trim() || turn.state.rawTail || `${spec.id} sandbox run completed`,
          Date.now() - startedAt,
        );
        succeeded = true;
      } finally {
        // Success in a thread → keep the sandbox for the next turn (auto-stop /
        // auto-delete contain cost). Failure/abort or no thread → tear down and
        // forget the mapping so the next turn starts clean.
        if (sandbox && (!retainForThread || !succeeded)) {
          if (ctx.threadId) threadSandboxes.delete(ctx.threadId);
          await sandbox.delete().catch(() => {});
        }
      }
    },
  };
}

export const sandboxOpencodeAdapter = makeSandboxAdapter(opencodeSpec);
export const sandboxClaudeAdapter = makeSandboxAdapter(claudeSpec);
export const sandboxCodexAdapter = makeSandboxAdapter(codexSpec);
