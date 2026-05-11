import { Daytona, type Sandbox } from "@daytona/sdk";
import type { EmitStep, EngineAdapter, EngineRunContext } from "./types";
import { composeTurnPrompt } from "./types";
import { basename, parseJsonLine, truncate } from "./util";
import { allowPermissionBypass } from "./permission-policy";
import {
  composeSecretEnv,
  materializeSecretFiles,
  PROVIDER_SECRET_NAMES,
} from "../secrets/inject";
import {
  prepareProviderGatewaySandbox,
  providerGatewayEnv,
  providerGatewaySandboxIsCurrent,
  providerGatewaySandboxLabels,
  providerGatewayWired,
} from "../provider-gateway/sandbox-config";

// ---------------------------------------------------------------------------
// Sandbox engine substrate — ALL user-facing engines (opencode / claude / codex)
// execute inside a per-THREAD Daytona cloud sandbox; local engine execution is
// deliberately gone. One shared runner owns the sandbox lifecycle (create /
// thread-reuse / resume / teardown), prompt staging, LIVE output streaming
// (background launch + poll-tail — Daytona's own session-command streaming API
// starves against real sandboxes, verified live), and exit policy. Each engine
// contributes a small spec: how to build its command, how to translate its
// JSONL, and how its native session id is captured/resumed — the reference bot model
// (explicit ids, persisted in the runs table via ctx.saveEngineSessionId,
// resumed via ctx.engineSessionId).
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-opus-5";
/** Pinned versions for npx-on-demand installs inside the sandbox (the default
 *  image has no engines preinstalled). */
const CLAUDE_CODE_VERSION = "2.1.222";
const CODEX_VERSION = "0.146.0";

/** In-sandbox paths for one engine turn: the staged prompt (fed via stdin
 *  redirect — see SandboxEngineSpec.command), the live output log the poll loop
 *  tails, the exit-code file the wrapper writes on completion, and the pid file
 *  used to kill a runaway engine on abort. */
const PROMPT_PATH = "/tmp/skynet-prompt.txt";
const OUT_PATH = "/tmp/skynet-out.log";
const EXIT_PATH = "/tmp/skynet-exit";
const PID_PATH = "/tmp/skynet-pid";

/** Poll cadence for tailing the engine's output. Low enough that steps feel
 *  live in the UI, high enough that the toolbox API isn't hammered. */
const POLL_MS = 2000;

/** Values interpolated into the engine command line (model ids, engine session
 *  ids) must match this or they're dropped — nothing user-controlled ever
 *  reaches the shell unvalidated. */
const SAFE_ARG = /^[A-Za-z0-9._/-]+$/;

const FILE_TOOLS_CLAUDE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** claude-code's subagent spawn tool — named `Task` historically, `Agent` in
 *  current releases (observed live on 2.1.222). Both mean "fan out". */
const SPAWN_TOOLS_CLAUDE = new Set(["Task", "Agent"]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One live sandbox per conversation. In-memory (a restart re-provisions);
 *  cost containment lives on the sandbox: 10m idle auto-stop + 2h auto-delete. */
const threadSandboxes = new Map<string, { sandboxId: string }>();

/** The live sandbox backing a conversation, if any — consumed by the terminal
 *  WS bridge to attach a PTY to the same box the engine works in. */
export function getThreadSandboxId(threadId: string): string | null {
  return threadSandboxes.get(threadId)?.sandboxId ?? null;
}

/** A claude tool call already SURFACED as a step (reference bot's tool_call event);
 *  kept so its tool_result can enrich that same step with output. */
interface PendingTool {
  name: string;
  input: Record<string, unknown>;
  subagent: boolean;
}

/** Mutable per-run parse state shared between the runner and a spec's line handler. */
interface ParseState {
  lastText: string;
  rawTail: string;
  seenTools: Set<string>;
  sessionId: string | null;
  pendingTools: Map<string, PendingTool>;
}

const newParseState = (): ParseState => ({
  lastText: "",
  rawTail: "",
  seenTools: new Set(),
  sessionId: null,
  pendingTools: new Map(),
});

/** What a spec's line handler asks the runner to do — mirrors reference bot's event
 *  contract: `step` ≙ tool_call/spawn surfaced immediately, `update` ≙
 *  tool_result enriching that same step, `delta` ≙ chat_chunk live narration. */
interface SpecAction {
  step?: EmitStep;
  /** With `step`: remember the persisted step id under this key. */
  pairKey?: string;
  /** Replace the code_json of the step remembered under `pairKey`. */
  update?: { pairKey: string; code_json: unknown };
  /** Live narration text pushed to the run's turn-stream. */
  delta?: string;
}

interface SandboxEngineSpec {
  /** Engine id as registered (also the step chip). */
  id: "claude" | "codex";
  /** Shell command for one turn. The runner feeds the staged prompt via STDIN
   *  (`< /tmp/skynet-prompt.txt`) — never as a positional argument, because a
   *  prompt whose first line starts with `---` (the team-memory block header)
   *  parses as a flag and kills the CLI with a usage error. All three engines
   *  read a piped prompt (verified live). */
  command(args: {
    model: string;
    resumeId: string | undefined;
  }): string;
  /** Package to install ONCE per sandbox (user prefix — npm -g needs root on
   *  the default image). Turns then invoke the resident binary directly instead
   *  of paying `npx -y` registry resolution + reinstall on EVERY message. */
  install: { pkg: string; bin: string };
  /** Translate one stdout line into runner actions. Must also maintain
   *  state.lastText / state.sessionId as its protocol reveals them. */
  handleLine(line: string, state: ParseState): SpecAction[];
  /** Extra sandbox preparation (e.g. codex auth seeding). Runs after create AND
   *  after reuse — must be idempotent and cheap. */
  prepare?(sandbox: Sandbox, ctx: EngineRunContext): Promise<void>;
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

// ── claude spec (claude CLI stream-json: system/init, assistant, user, result) ─

/** Render one claude tool call as a step. `output` present ⇒ its tool_result
 *  already arrived and the step carries both sides. */
function claudeToolStep(
  name: string,
  input: Record<string, unknown>,
  output: string | undefined,
  subagent: boolean,
): EmitStep {
  const isFile = FILE_TOOLS_CLAUDE.has(name);
  const path = String(input.file_path ?? input.path ?? "");
  // Any tool that names a file shows it (Read/Grep included), not just writers.
  const label =
    name === "Bash"
      ? truncate(String(input.command ?? "bash"))
      : path
        ? isFile
          ? basename(path)
          : `${name} ${basename(path)}`
        : name;
  return {
    kind: isFile ? "file" : "command",
    label: (subagent ? "↳ " : "") + label,
    chip: name === "Bash" ? "bash" : isFile ? "file" : name,
    code_json: {
      tool: name,
      input,
      ...(output !== undefined ? { output: output.slice(0, 2000) } : {}),
    },
  };
}

/** Flatten a tool_result's content (string or [{type:"text",text}] blocks). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          ? ((c as { text: string }).text)
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// Exported for the P0 CLI-argument regression test (permission-policy.test.ts):
// the command string must not carry --dangerously-skip-permissions outside dev-yolo.
export const claudeSpec: SandboxEngineSpec = {
  id: "claude",
  command: ({ model, resumeId }) => {
    // Model is engine-managed (Anthropic only); the picker applies to opencode.
    const resume = resumeId ? `--resume ${resumeId} ` : "";
    // SECURITY (final_harness.md P0): only pass --dangerously-skip-permissions in
    // verified-dev yolo mode (permission-policy.ts). Without it a non-interactive
    // CLI cannot approve tools - fail-closed, the intended SaaS default.
    const skip = allowPermissionBypass() ? " --dangerously-skip-permissions" : "";
    return `claude -p ${resume}--model ${model} --output-format stream-json --verbose${skip}`;
  },
  install: { pkg: `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`, bin: "claude" },
  prepare: (sandbox, ctx) => prepareProviderGatewaySandbox(sandbox, ctx, "claude"),
  handleLine: (line, state) => {
    const ev = parseJsonLine(line);
    if (!ev) {
      noteRawLine(line, state);
      return [];
    }
    if (!state.sessionId) state.sessionId = anySessionId(ev);
    // Events emitted from INSIDE a subagent carry the spawning tool id — tag
    // them so the worklog shows the fan-out (claude's own UI does the same).
    const subagent =
      typeof ev.parent_tool_use_id === "string" && ev.parent_tool_use_id.length > 0;
    const actions: SpecAction[] = [];

    if (ev.type === "assistant") {
      const content =
        ((ev as { message?: { content?: unknown[] } }).message?.content ?? []) as {
          type?: string;
          id?: string;
          text?: string;
          name?: string;
          input?: Record<string, unknown>;
        }[];
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          // Subagent narration never overwrites the MAIN agent's final text and
          // never streams into the main turn's live-typing channel.
          if (!subagent) state.lastText = block.text;
          actions.push({
            step: {
              kind: "task",
              label: (subagent ? "↳ " : "") + truncate(block.text, 60),
              chip: "task",
            },
            ...(subagent ? {} : { delta: block.text }),
          });
        } else if (block.type === "tool_use" && block.name) {
          const input = block.input ?? {};
          if (SPAWN_TOOLS_CLAUDE.has(block.name)) {
            // A subagent spawn is a step of its own, emitted IMMEDIATELY (its
            // result may be minutes away).
            const desc = String(input.description ?? input.prompt ?? "subagent");
            actions.push({
              step: {
                kind: "task",
                label: `${subagent ? "↳ " : ""}Subagent — ${truncate(desc, 50)}`,
                chip: "subagent",
                code_json: { tool: block.name, input },
              },
            });
          } else if (block.id) {
            // Surface the call NOW; its tool_result enriches this same step.
            state.pendingTools.set(block.id, { name: block.name, input, subagent });
            actions.push({
              step: claudeToolStep(block.name, input, undefined, subagent),
              pairKey: block.id,
            });
          } else {
            actions.push({ step: claudeToolStep(block.name, input, undefined, subagent) });
          }
        }
      }
      return actions;
    }

    if (ev.type === "user") {
      const content =
        ((ev as { message?: { content?: unknown[] } }).message?.content ?? []) as {
          type?: string;
          tool_use_id?: string;
          content?: unknown;
        }[];
      for (const block of content) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        const held = state.pendingTools.get(block.tool_use_id);
        if (!held) continue;
        state.pendingTools.delete(block.tool_use_id);
        actions.push({
          update: {
            pairKey: block.tool_use_id,
            code_json: {
              tool: held.name,
              input: held.input,
              output: toolResultText(block.content).slice(0, 2000),
            },
          },
        });
      }
      return actions;
    }

    if (ev.type === "result") {
      // Final reconciliation only — the assistant text blocks already streamed
      // as deltas; re-publishing the full result here would duplicate the
      // answer for every delta consumer.
      const text = (ev as { result?: string }).result;
      if (typeof text === "string" && text.trim()) state.lastText = text;
      return []; // the runner emits the done step
    }
    return actions;
  },
};

// ── codex spec (codex exec --json JSONL; auth seeded from the host) ──────────

const codexSpec: SandboxEngineSpec = {
  id: "codex",
  command: ({ resumeId }) => {
    const sub = resumeId ? `exec resume ${resumeId}` : "exec";
    return (
      `codex ${sub} --json --skip-git-repo-check ` +
      `--dangerously-bypass-approvals-and-sandbox`
    );
  },
  install: { pkg: `@openai/codex@${CODEX_VERSION}`, bin: "codex" },
  prepare: (sandbox, ctx) => prepareProviderGatewaySandbox(sandbox, ctx, "codex"),
  handleLine: (line, state) => {
    const ev = parseJsonLine(line);
    if (!ev) {
      noteRawLine(line, state);
      return [];
    }
    if (!state.sessionId) state.sessionId = anySessionId(ev);
    const item = (ev as { item?: Record<string, unknown> }).item;
    const itemType = item?.type as string | undefined;
    // item.started → surface a command the moment codex launches it; the
    // matching item.completed enriches the SAME step with its output.
    if (ev.type === "item.started" && item && itemType === "command_execution") {
      const id = String(item.id ?? "");
      const cmd = String(item.command ?? "command");
      if (id && !state.pendingTools.has(id)) {
        state.pendingTools.set(id, { name: "bash", input: { command: cmd }, subagent: false });
        return [
          {
            step: { kind: "command", label: truncate(cmd), chip: "bash", code_json: { command: cmd } },
            pairKey: id,
          },
        ];
      }
      return [];
    }
    if (ev.type !== "item.completed" || !item) return [];
    if (itemType === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      state.lastText = item.text;
      return [
        {
          step: { kind: "task", label: truncate(item.text, 60), chip: "task" },
          delta: item.text,
        },
      ];
    }
    if (itemType === "reasoning" && typeof item.text === "string" && item.text.trim()) {
      return [{ step: { kind: "task", label: truncate(item.text, 60), chip: "reasoning" } }];
    }
    if (itemType === "web_search") {
      const query = String(item.query ?? "web search");
      return [{ step: { kind: "command", label: truncate(query), chip: "search", code_json: item } }];
    }
    if (itemType === "mcp_tool_call") {
      const tool = String(item.tool ?? item.server ?? "mcp");
      return [{ step: { kind: "command", label: truncate(tool), chip: tool, code_json: item } }];
    }
    if (itemType === "command_execution") {
      const id = String(item.id ?? "");
      const cmd = String(item.command ?? "command");
      const code = {
        command: cmd,
        output: String(item.aggregated_output ?? "").slice(0, 2000),
        exit_code: item.exit_code ?? null,
      };
      if (id && state.pendingTools.has(id)) {
        state.pendingTools.delete(id);
        return [{ update: { pairKey: id, code_json: code } }];
      }
      return [{ step: { kind: "command", label: truncate(cmd), chip: "bash", code_json: code } }];
    }
    if (itemType === "file_change" || itemType === "patch_apply") {
      const changes = (item.changes ?? item.files ?? []) as { path?: string }[];
      const first =
        Array.isArray(changes) && changes[0]?.path ? basename(String(changes[0].path)) : "files";
      return [{ step: { kind: "file", label: first, chip: "file", code_json: item } }];
    }
    return [];
  },
  // SaaS-SAFE credentials (final_harness.md P0): Codex authenticates ONLY from
  // per-tenant credentials injected via org secrets (e.g. OPENAI_API_KEY) - see
  // src/secrets/inject.ts. We NEVER copy the host operator's ~/.codex/auth.json
  // (a developer's ChatGPT login) into an untrusted customer sandbox. There is no
  // `prepare` hook: an enabled codex run with no injected credential fails on
  // codex's own auth error - fail-closed - rather than borrowing the host identity.
};

// ── the shared runner ────────────────────────────────────────────────────────

function makeSandboxAdapter(spec: SandboxEngineSpec): EngineAdapter {
  return {
    id: spec.id as EngineAdapter["id"],

    async run(ctx: EngineRunContext): Promise<void> {
      const apiKey = process.env.DAYTONA_API_KEY;
      if (!apiKey) throw new Error(`${spec.id} engine needs DAYTONA_API_KEY in the backend env`);
      if (!providerGatewayWired()) {
        throw new Error(`${spec.id} engine requires a configured provider gateway`);
      }
      const startedAt = Date.now();
      const daytona = new Daytona({ apiKey, target: process.env.DAYTONA_TARGET ?? "us" });

      // Engine/provider keys ride as sandbox env — never on the command line.
      // Org secrets ride in via a BASH_ENV dotenv (createEnv), not as N env vars;
      // platform keys of the same name win. Same seam as the opencode/acp
      // adapters; also records the `secrets.injected` marker. The dotenv +
      // file-kind secrets are written after boot (below).
      const secretInjection = await composeSecretEnv(ctx, {
        excludeNames: PROVIDER_SECRET_NAMES,
      });
      // Provider authentication is brokered by the trusted gateway. No raw host
      // or tenant provider credential is ever injected into this sandbox.
      const envVars: Record<string, string> = {
        ...secretInjection.createEnv,
        ...providerGatewayEnv(ctx, spec.id),
      };

      // The org's snapshot (2 vCPU / 8 GiB, opencode preinstalled). The bare
      // "skynet-agent" name does NOT exist — a wrong name silently drops every
      // opencode run onto the tiny default image, which OOM-kills (137) the
      // npx-installed CLI mid-run. Keep this in sync with `daytona snapshot list`.
      // A STOPPED sandbox keeps its disk (workspace + engine sessions) at ~zero
      // cost and restarts in seconds — so stop quickly, but keep the thread's
      // world alive for days before deletion.
      const autoStopInterval = Number(process.env.SANDBOX_AUTO_STOP_MIN ?? 30);
      const autoDeleteInterval = Number(process.env.SANDBOX_AUTO_DELETE_MIN ?? 4320); // 3 days
      let sandbox: Sandbox | null = null;
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
            if (!(await providerGatewaySandboxIsCurrent(prior))) {
              await prior.delete().catch(() => {});
              throw new Error("legacy sandbox credential generation");
            }
            sandbox = prior;
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
          // Default image (user `daytona`): the root-running snapshot refuses
          // `claude --dangerously-skip-permissions`. The engine binary installs
          // once below and stays resident for the sandbox's lifetime.
          sandbox = await daytona.create({
            envVars,
            labels: providerGatewaySandboxLabels(ctx.runId),
            autoStopInterval,
            autoDeleteInterval,
          });
          await ctx.emit({
            kind: "task",
            label: `Sandbox ${sandbox.id.slice(0, 8)} ready in ${Math.round((Date.now() - startedAt) / 1000)}s`,
            chip: spec.id,
          });
          if (ctx.threadId) {
            threadSandboxes.set(ctx.threadId, { sandboxId: sandbox.id });
            retainForThread = true;
          }
        }
        if (ctx.signal.aborted) throw new Error(`${spec.id} run aborted (timeout)`);

        // Resident binary: install ONCE per sandbox into the user prefix (npm -g
        // needs root here), then every turn invokes it directly — no npx
        // resolution tax per message. Idempotent probe first, so reuse is free.
        const probe = await sandbox.process.executeCommand(
          `export PATH=$HOME/.local/bin:$PATH; command -v ${spec.install.bin} >/dev/null 2>&1 && echo OK`,
          undefined,
          undefined,
          15,
        );
        if (!(probe.result ?? "").includes("OK")) {
          await ctx.emit({ kind: "task", label: `Installing ${spec.install.bin} (once per sandbox)…`, chip: spec.id });
          const inst = await sandbox.process.executeCommand(
            `npm install -g --prefix $HOME/.local --silent ${spec.install.pkg} 2>&1 | tail -2`,
            undefined,
            undefined,
            180,
          );
          if ((inst.exitCode ?? 1) !== 0) {
            throw new Error(`failed to install ${spec.install.pkg}: ${truncate(inst.result ?? "", 200)}`);
          }
        }

        await spec.prepare?.(sandbox, ctx);

        // Explicit native-session resume: id from the DB (previous turn, same
        // engine). Resuming ⇒ the engine holds the history — send ONLY the new
        // prompt; fresh ⇒ composed preamble (team memory + thread fallback).
        // Both interpolated values are validated before touching the shell.
        const rawResume = ctx.engineSessionId;
        const resumeId = rawResume && SAFE_ARG.test(rawResume) ? rawResume : undefined;
        const rawModel = ctx.model?.trim() ?? "";
        const model = SAFE_ARG.test(rawModel) ? rawModel : DEFAULT_MODEL;
        const box = sandbox;

        // Materialize any file-kind org secrets (0600) before the agent turn.
        await materializeSecretFiles(
          (cmd) => box.process.executeCommand(cmd, undefined, undefined, 30),
          secretInjection.files,
        );

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

        // One engine turn, streamed LIVE: launch the CLI detached (output to a
        // log, exit code + pid to files), then poll-tail the log translating
        // complete JSONL lines into steps as they land. Session id persists the
        // moment the stream reveals it. Abort/budget overrun kills the pid.
        const execTurn = async (
          resume: string | undefined,
        ): Promise<{ exitCode: number; state: ParseState; produced: boolean }> => {
          const command = spec.command({ model, resumeId: resume });
          const launch = await box.process.executeCommand(
            `rm -f ${OUT_PATH} ${EXIT_PATH} ${PID_PATH}; export PATH=$HOME/.local/bin:$PATH; cd ~/work && ` +
              `nohup sh -c '${command} < ${PROMPT_PATH}; echo $? > ${EXIT_PATH}' ` +
              `> ${OUT_PATH} 2>&1 & echo $! > ${PID_PATH}`,
            undefined,
            undefined,
            30,
          );
          if ((launch.exitCode ?? 1) !== 0) {
            throw new Error(`failed to launch ${spec.id} in sandbox`);
          }

          const state = newParseState();
          const pairIds = new Map<string, string>(); // spec pairKey → persisted step id
          // One streaming decoder across ALL chunks: offsets are BYTES and a
          // chunk boundary can split a multibyte UTF-8 char — chunks travel as
          // base64 and decode statefully, never per-chunk.
          const decoder = new TextDecoder();
          let emittedSteps = 0;
          let offset = 0;
          let partial = "";
          let exitCode: number | null = null;

          const apply = async (actions: SpecAction[]): Promise<void> => {
            for (const a of actions) {
              if (a.delta) ctx.publishDelta?.(a.delta);
              if (a.step) {
                const id = await ctx.emit(a.step);
                emittedSteps += 1;
                if (a.pairKey && id) pairIds.set(a.pairKey, id);
              }
              if (a.update) {
                const sid = pairIds.get(a.update.pairKey);
                if (sid) await ctx.updateStep?.(sid, a.update.code_json);
              }
            }
          };

          const feedB64 = async (b64: string): Promise<void> => {
            const bytes = Buffer.from(b64.replace(/\s+/g, ""), "base64");
            partial += decoder.decode(bytes, { stream: true });
            const lines = partial.split("\n");
            partial = lines.pop() ?? "";
            for (const l of lines) await apply(spec.handleLine(l, state));
          };

          while (true) {
            if (ctx.signal.aborted || Date.now() - startedAt > budgetSec * 1000) {
              // Kill children FIRST: the pid file holds the `sh -c` wrapper, and
              // killing only it would orphan the npx/engine child, which keeps
              // burning the sandbox.
              await box.process
                .executeCommand(
                  `pkill -9 -P $(cat ${PID_PATH}) 2>/dev/null; kill -9 $(cat ${PID_PATH}) 2>/dev/null`,
                  undefined,
                  undefined,
                  15,
                )
                .catch(() => {});
              throw new Error(`${spec.id} run aborted (timeout)`);
            }
            await sleep(POLL_MS);
            // Size FIRST, exit second: if the engine finishes in between, the
            // stale size just means one final drain below picks up the rest.
            const st = await box.process.executeCommand(
              `printf '%s\\n' "$(wc -c < ${OUT_PATH} 2>/dev/null || echo 0)" "$(cat ${EXIT_PATH} 2>/dev/null)"`,
              undefined,
              undefined,
              30,
            );
            const [sizeLine, exitLine] = (st.result ?? "").split("\n");
            const size = Number((sizeLine ?? "").trim()) || 0;
            if (size > offset) {
              const chunk = await box.process.executeCommand(
                `tail -c +${offset + 1} ${OUT_PATH} | head -c ${size - offset} | base64`,
                undefined,
                undefined,
                30,
              );
              await feedB64(chunk.result ?? "");
              offset = size;
            }
            if (exitLine !== undefined && exitLine.trim() !== "") {
              exitCode = Number(exitLine.trim());
              const rest = await box.process.executeCommand(
                `tail -c +${offset + 1} ${OUT_PATH} | base64`,
                undefined,
                undefined,
                30,
              );
              await feedB64(rest.result ?? "");
              partial += decoder.decode(); // flush the streaming decoder
              if (partial.trim()) await apply(spec.handleLine(partial, state));
              break;
            }
          }

          if (state.sessionId) ctx.saveEngineSessionId?.(state.sessionId);
          // 137 = SIGKILL at teardown AFTER work streamed; only fatal when the
          // turn produced nothing at all. `emittedSteps` counts EVERY emitted
          // action (tools included) so a tools-but-no-text turn is never
          // classified empty and re-executed (double mutation hazard).
          const produced = state.lastText.trim().length > 0 || emittedSteps > 0;
          return { exitCode: exitCode ?? 0, state, produced };
        };

        await stagePrompt(composeTurnPrompt(ctx, Boolean(resumeId)));
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
          await stagePrompt(composeTurnPrompt(ctx, false));
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
        // A thread's sandbox is the conversation's world — a failed TURN must
        // not destroy it (auto-stop/auto-delete contain cost). Only runs
        // without a thread clean up their box.
        if (sandbox && !ctx.threadId) {
          await sandbox.delete().catch(() => {});
        }
      }
    },
  };
}

export const sandboxClaudeAdapter = makeSandboxAdapter(claudeSpec);
export const sandboxCodexAdapter = makeSandboxAdapter(codexSpec);
