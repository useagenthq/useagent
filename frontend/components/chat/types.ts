// Wire types + small parse helpers for the coding-session surface. These mirror
// the Skynet backend contract (:3201) verbatim — snake_case as the API sends it.

import type { RunStatus } from "@/lib/runs";

export type EngineId =
  // Selectable, sandbox-only engines (see ENGINES below).
  | "opencode"
  | "claude"
  | "codex"
  // Legacy ids kept so old runs/rows still type; never offered in the picker.
  | "mock"
  | "claude-sdk"
  | "daytona"
  | "acp";
export type StepKind = "command" | "file" | "task" | "done";
/** Which team-memory pool a run reads/writes (backend `memory_scope`). */
export type MemoryScope = "org" | "personal";
export type { RunStatus };

export interface ApiStep {
  id: string;
  run_id: string;
  idx: number;
  kind: StepKind;
  label: string;
  chip: string | null;
  code_json: string | null;
  created_at: string;
}

export interface ApiRun {
  id: string;
  org_id: string | null;
  user_id: string | null;
  parent_run_id?: string | null;
  prompt: string;
  model: string;
  engine: EngineId;
  status: RunStatus;
  summary: string | null;
  duration_ms: number | null;
  /** The engine's own native session id (opencode `ses_*`), when one was
   * recorded for this run. The thread's latest non-null value deep-links the
   * "Live" tab straight into that session (see session-view.tsx / live-pane.tsx). */
  engine_session_id?: string | null;
  /** Which team-memory pool this run reads/writes. A reply's composer defaults to
   *  the thread's current scope (its newest run). Optional so a pre-scope run
   *  shape still parses; treated as "org" when absent. */
  memory_scope?: MemoryScope;
  created_at: string;
  updated_at: string;
  steps: ApiStep[];
}

/** `GET /api/runs/:id?thread=1` → the whole conversation, oldest → newest. */
export interface ThreadResponse {
  thread: ApiRun[];
}

/**
 * Normalize a `GET /api/runs/:id?thread=1` response into an oldest→newest run
 * list. Tolerates the pre-thread single-run shape so the session page renders
 * correctly before the backend thread endpoint ships.
 */
export function toThread(data: unknown): ApiRun[] {
  if (data && typeof data === "object") {
    const thread = (data as { thread?: unknown }).thread;
    if (Array.isArray(thread)) return thread as ApiRun[];
    if (typeof (data as ApiRun).id === "string") return [data as ApiRun];
  }
  return [];
}

/**
 * Show a turn's bubble as just what the user typed. New runs store the clean
 * prompt (backend contract), but legacy runs stuffed a
 * "Follow-up to a previous task. … New request: X" wrapper into `prompt`; strip
 * it back to `X` so no plumbing leaks into the conversation.
 */
export function cleanPrompt(prompt: string): string {
  if (!/follow-up to a previous task/i.test(prompt)) return prompt.trim();
  const marker = "New request:";
  const idx = prompt.lastIndexOf(marker);
  return idx === -1 ? prompt.trim() : prompt.slice(idx + marker.length).trim();
}

// The user-selectable engines, in display order (opencode is the default = ENGINES[0]).
// Every engine now runs one-shot in a cloud sandbox. The legacy ids
// ("mock", "claude-sdk", "daytona", "acp") stay in the EngineId union so old
// runs/rows still type, but are intentionally omitted here — they never render
// as a choice and fall back to their raw id via engineLabel().
export const ENGINES: { id: EngineId; label: string; hint: string }[] = [
  { id: "opencode", label: "OpenCode", hint: "any model · cloud sandbox" },
  // claude/codex are DEFERRED, not removed (task #15): their resident-ACP
  // backend adapters exist and the ids stay valid — re-add rows here once the
  // native-binary install path is verified.
];

export function engineLabel(id: EngineId): string {
  return ENGINES.find((e) => e.id === id)?.label ?? id;
}

/** The curated model set (single source of truth for every picker). Bare ids →
 * Anthropic direct; provider/model ids → OpenRouter. */
export const MODELS: { value: string; label: string; tint: string }[] = [
  { value: "claude-opus-5", label: "Opus 5", tint: "text-orange-500" },
  { value: "claude-sonnet-5", label: "Sonnet 5", tint: "text-blue-500" },
  { value: "claude-fable-5", label: "Fable 5", tint: "text-purple-500" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", tint: "text-green-500" },
  { value: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", tint: "text-teal-500" },
  { value: "openai/gpt-5.6-sol-pro", label: "GPT-5.6 Sol Pro", tint: "text-teal-500" },
  { value: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", tint: "text-sky-500" },
  { value: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", tint: "text-amber-500" },
];

export function modelLabel(value: string): string {
  return MODELS.find((m) => m.value === value)?.label ?? value;
}

/** Fold a legacy engine id into its current sandbox equivalent (the backend
 * aliases them the same way), so old threads pick up the modern picker entry
 * instead of surfacing a raw legacy id. */
export function normalizeEngine(id: EngineId): EngineId {
  if (id === "claude-sdk") return "claude";
  if (id === "daytona") return "opencode";
  return id;
}

/** A run is "live" while the backend worker is still producing steps. */
export function isLiveStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

/** Safely parse a step's `code_json` payload (a JSON string or null). */
export function parseStepCode(step: ApiStep): unknown {
  if (!step.code_json) return null;
  try {
    return JSON.parse(step.code_json);
  } catch {
    return step.code_json;
  }
}

export function basename(path: string): string {
  const clean = path.trim().replace(/[/\\]+$/, "");
  const parts = clean.split(/[/\\]/);
  return parts[parts.length - 1] || clean;
}

/** Directory portion of a path, with the engine's `.runs/<id>/` sandbox prefix
 * stripped so it reads as a repo-relative parent (may be empty for root files). */
export function parentDir(path: string): string {
  const clean = path.trim().replace(/[/\\]+$/, "");
  const parts = clean.split(/[/\\]/).filter(Boolean);
  parts.pop(); // drop basename
  const runsIdx = parts.indexOf(".runs");
  return (runsIdx >= 0 ? parts.slice(runsIdx + 2) : parts).join("/");
}

// ── Command steps ──────────────────────────────────────────────────────────

/** A command step's structured payload: `{command, exit_code, output}`. */
export interface CommandStep {
  command: string;
  exitCode: number | null;
  output: string | null;
  durationMs: number | null;
}

export function parseCommandStep(step: ApiStep): CommandStep {
  const code = parseStepCode(step);
  let command = step.label;
  let output: string | null = null;
  let exitCode: number | null = null;
  let durationMs: number | null = null;

  if (code && typeof code === "object" && !Array.isArray(code)) {
    const obj = code as Record<string, unknown>;
    // The command lives top-level for codex (`{command, output, exit_code}`) but
    // nested under `input` for the tool-shaped engines (`{tool, input:{command}}`).
    const input =
      obj.input && typeof obj.input === "object" && !Array.isArray(obj.input)
        ? (obj.input as Record<string, unknown>)
        : null;
    if (typeof obj.command === "string" && obj.command.trim())
      command = obj.command;
    else if (input && typeof input.command === "string" && input.command.trim())
      command = input.command;
    if (typeof obj.output === "string") output = obj.output;
    else if (typeof obj.stdout === "string") output = obj.stdout;
    if (typeof obj.exit_code === "number") exitCode = obj.exit_code;
    else if (typeof obj.exitCode === "number") exitCode = obj.exitCode;
    if (typeof obj.duration_ms === "number") durationMs = obj.duration_ms;
    else if (typeof obj.durationMs === "number") durationMs = obj.durationMs;
  }
  if (output != null) output = output.replace(/\s+$/, "") || null;
  return { command, exitCode, output, durationMs };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

// ── File steps ─────────────────────────────────────────────────────────────

export type FileChangeKind = "add" | "edit" | "delete";

/** One changed file parsed out of a file step's payload. */
export interface FileEntry {
  path: string;
  base: string;
  dir: string;
  kind: FileChangeKind;
  /** File body, if the engine mirrored it (content/code/diff). Usually absent. */
  content?: string;
}

function normalizeKind(kind: unknown): FileChangeKind {
  const k = typeof kind === "string" ? kind.toLowerCase() : "";
  if (k === "add" || k === "create" || k === "new") return "add";
  if (k === "delete" || k === "remove" || k === "del") return "delete";
  return "edit";
}

function pickPath(obj: Record<string, unknown>): string | null {
  for (const key of ["path", "file", "filename", "file_path", "filePath"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // Tool-shaped payloads nest the path under `input` (`{tool, input:{file_path}}`).
  const input = obj.input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return pickPath(input as Record<string, unknown>);
  }
  return null;
}

/**
 * Parse a file step's payload into concrete file entries. A step may carry a
 * single `{path, kind}` object or a `[{path, kind}, …]` list (an "N files"
 * step). Returns `[]` for payload-less engines (e.g. the mock's bare "Editing
 * file"), so callers can fall back to a plain row and the editor stays honest.
 */
export function parseFileEntries(step: ApiStep): FileEntry[] {
  const code = parseStepCode(step);
  const items: Record<string, unknown>[] = Array.isArray(code)
    ? code.filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === "object")
    : code && typeof code === "object"
      ? [code as Record<string, unknown>]
      : [];

  const entries: FileEntry[] = [];
  for (const item of items) {
    const path = pickPath(item);
    if (!path) continue;
    // Full file body, when the engine mirrored it. Live only for whole-file
    // writes (`input.content`); an Edit's `new_string` is a fragment, never the
    // whole file, so it is deliberately NOT treated as content.
    const input =
      item.input && typeof item.input === "object" && !Array.isArray(item.input)
        ? (item.input as Record<string, unknown>)
        : null;
    const body = ["content", "code", "diff"]
      .flatMap((k) => [item[k], input?.[k]])
      .find((v): v is string => typeof v === "string" && v.length > 0);
    entries.push({
      path,
      base: basename(path),
      dir: parentDir(path),
      kind: normalizeKind(item.kind ?? item.action ?? item.change),
      content: body,
    });
  }
  return entries;
}

// ── Trace rows (beautiful-ui verb + target grammar) ─────────────────────────

/** Which glyph family a trace row uses (the row maps this → a remix icon). */
export type TraceGlyph =
  | "read"
  | "edit"
  | "write"
  | "run"
  | "search"
  | "list"
  | "fetch"
  | "subagent"
  | "reasoning"
  | "task"
  | "boot";

/** Distinct visual treatment for a row beyond the default. */
export type TraceAccent = "subagent" | "boot" | null;

/**
 * A run step, normalized into the beautiful-ui trace grammar: a bold leading
 * verb + a (usually monospace) target, an optional derived line-diff, and an
 * expandable body (command output / a subagent's prompt). Derived fresh from
 * `code_json` on every render so an in-place step update (same idx, enriched
 * payload) re-reads its new output without any memo staleness.
 */
export interface StepTrace {
  verb: string;
  target: string;
  /** Render the target in the mono font (paths, commands, queries stay prose). */
  monoTarget: boolean;
  glyph: TraceGlyph;
  /** basename when the target is a file, so the row can pick an ext-based icon. */
  base: string | null;
  /** Expandable body (command output / a subagent's prompt); null ⇒ no disclosure. */
  detail: string | null;
  exitCode: number | null;
  durationMs: number | null;
  /** Line-diff, only when the payload actually carries one (never fabricated). */
  adds: number | null;
  dels: number | null;
  accent: TraceAccent;
  /** Nested subagent activity (was "↳ "-prefixed); render one indent deeper. */
  nested: boolean;
  /** The step ended in error — a native tool error (`code_json.error`) or a
   *  non-zero command exit. Drives the row's error styling. */
  isError: boolean;
}

/** Engine ids that tag a sandbox lifecycle/boot row (chip === engine id). */
const ENGINE_CHIPS = new Set<string>(["opencode", "claude", "codex"]);

/** Tool name (lower-cased) → its display verb + glyph family. */
const TOOL_VERB: Record<string, { verb: string; glyph: TraceGlyph }> = {
  read: { verb: "Read", glyph: "read" },
  grep: { verb: "Search", glyph: "search" },
  glob: { verb: "Search", glyph: "search" },
  list: { verb: "List", glyph: "list" },
  ls: { verb: "List", glyph: "list" },
  webfetch: { verb: "Fetch", glyph: "fetch" },
  fetch: { verb: "Fetch", glyph: "fetch" },
  websearch: { verb: "Search", glyph: "search" },
  write: { verb: "Write", glyph: "write" },
  edit: { verb: "Edit", glyph: "edit" },
  multiedit: { verb: "Edit", glyph: "edit" },
  notebookedit: { verb: "Edit", glyph: "edit" },
  patch: { verb: "Edit", glyph: "edit" },
  apply_patch: { verb: "Edit", glyph: "edit" },
  bash: { verb: "Run", glyph: "run" },
  shell: { verb: "Run", glyph: "run" },
  // `todowrite` is intentionally NOT catalogued here — it's rendered specially by
  // parseTodos → <TodoList>; its rare empty-plan fallback keeps the generic
  // humanised row (`Todowrite`). `question`/`skill` humanise cleanly on their own.
};

const FILE_GLYPHS = new Set<TraceGlyph>(["read", "edit", "write", "list"]);

/** Narrow an unknown JSON value to a plain object, or null. Shared with the
 *  subagent-attribution module (`./subagents`) for reading `code_json.native`. */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function pickString(
  obj: Record<string, unknown> | null,
  keys: string[],
): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

const lineCount = (s: string | null): number => (s ? s.split("\n").length : 0);

/** Count `+`/`-` body lines of a unified diff (ignoring the `+++`/`---` header). */
function countPatch(patch: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds++;
    else if (line.startsWith("-") && !line.startsWith("---")) dels++;
  }
  return { adds, dels };
}

/**
 * Derive a `+adds -dels` line-diff from a file tool's input — but ONLY from real
 * data (an Edit's old/new strings, a MultiEdit's edits, or an explicit patch).
 * Single-line-for-single-line replacements are suppressed (they read as noise,
 * not a meaningful line delta). Returns null when nothing is derivable.
 */
function diffStat(
  input: Record<string, unknown> | null,
): { adds: number; dels: number } | null {
  if (!input) return null;

  const edits = input.edits;
  if (Array.isArray(edits)) {
    let adds = 0;
    let dels = 0;
    let seen = false;
    for (const raw of edits) {
      const e = asRecord(raw);
      if (!e) continue;
      const oldS = pickString(e, ["old_string", "oldString"]);
      const newS = pickString(e, ["new_string", "newString"]);
      if (oldS == null && newS == null) continue;
      seen = true;
      adds += lineCount(newS);
      dels += lineCount(oldS);
    }
    return seen ? denoise(adds, dels) : null;
  }

  const oldS = pickString(input, ["old_string", "oldString"]);
  const newS = pickString(input, ["new_string", "newString"]);
  if (oldS != null || newS != null) return denoise(lineCount(newS), lineCount(oldS));

  const patch = pickString(input, ["patch", "diff"]);
  if (patch) {
    const p = countPatch(patch);
    return denoise(p.adds, p.dels);
  }

  return null;
}

/** Drop trivial single-line-for-single-line churn; keep real multi-line diffs. */
function denoise(adds: number, dels: number): { adds: number; dels: number } | null {
  if (adds <= 1 && dels <= 1) return null;
  return { adds, dels };
}

/**
 * Normalize one run step into the trace grammar. Reads `code_json` directly (via
 * `parseStepCode`) so it always reflects the latest in-place update.
 */
export function deriveTrace(step: ApiStep): StepTrace {
  const code = asRecord(parseStepCode(step));
  const rawLabel = step.label ?? "";
  const nested = /^↳/.test(rawLabel);
  const label = rawLabel.replace(/^↳\s*/, "");

  const tool = pickString(code, ["tool"]);
  const input = asRecord(code?.input);
  const output = pickString(code, ["output", "stdout"]);
  // Native tool error state the backend now stamps (`code_json.error`), the
  // ID-backed replacement for guessing failure from output text.
  const nativeError = code?.error === true;

  const base: StepTrace = {
    verb: "Thinking",
    target: label,
    monoTarget: false,
    glyph: "task",
    base: null,
    detail: null,
    exitCode: null,
    durationMs: null,
    adds: null,
    dels: null,
    accent: null,
    nested,
    isError: nativeError,
  };

  // 1. Subagent spawn — a fan-out of its own, distinctly accented.
  if (step.chip === "subagent") {
    const prompt = pickString(input, ["prompt"]);
    const desc =
      pickString(input, ["description"]) ??
      prompt ??
      label.replace(/^Subagent\s*—\s*/, "");
    return {
      ...base,
      verb: "Subagent",
      target: desc,
      glyph: "subagent",
      accent: "subagent",
      detail: prompt,
    };
  }

  // 2. Sandbox lifecycle/boot rows (task steps chipped with the engine id).
  // The live "Thinking…" indicator is NOT sandbox plumbing — render it as
  // plain "Thinking" (user: "SandboxThinking change this to just thinking").
  if (step.kind === "task" && step.chip && ENGINE_CHIPS.has(step.chip)) {
    if (/^Thinking/.test(label)) {
      return { ...base, verb: "Thinking", target: "", glyph: "reasoning", accent: "boot" };
    }
    return { ...base, verb: "Sandbox", target: label, glyph: "boot", accent: "boot" };
  }

  // 3. Codex reasoning.
  if (step.chip === "reasoning") {
    return { ...base, verb: "Reasoning", target: label, glyph: "reasoning" };
  }

  // 4. Web / MCP search.
  if (step.chip === "search") {
    return {
      ...base,
      verb: "Search",
      glyph: "search",
      target: pickString(code, ["query"]) ?? label,
    };
  }

  // 5. Command / file tool calls.
  if (step.kind === "command" || step.kind === "file") {
    const cmd = parseCommandStep(step);
    const filePath = pickString(input, ["file_path", "filePath", "path", "filename"]);
    const map = tool ? TOOL_VERB[tool.toLowerCase()] : undefined;
    // A shell-executed step also fails on a non-zero exit, not only a native
    // tool error; file-shaped steps carry no exit and rely on `nativeError`.
    const cmdError = nativeError || (cmd.exitCode !== null && cmd.exitCode !== 0);

    // File-shaped: an explicit file step, or a file tool that named a path.
    if (step.kind === "file" || (filePath && map && FILE_GLYPHS.has(map.glyph))) {
      const fileBase = filePath ? basename(filePath) : basename(label);
      const stat = diffStat(input);
      return {
        ...base,
        verb: map?.verb ?? "Edit",
        target: fileBase,
        monoTarget: true,
        glyph: map?.glyph ?? "edit",
        base: fileBase,
        detail: output,
        adds: stat?.adds ?? null,
        dels: stat?.dels ?? null,
      };
    }

    // A tool that reads/searches a path (Read/Grep foo.ts) targets the file.
    if (map && filePath && (map.glyph === "read" || map.glyph === "search" || map.glyph === "list")) {
      const fileBase = basename(filePath);
      return {
        ...base,
        verb: map.verb,
        target: fileBase,
        monoTarget: true,
        glyph: map.glyph,
        base: fileBase,
        detail: cmd.output,
        exitCode: cmd.exitCode,
        durationMs: cmd.durationMs,
        isError: cmdError,
      };
    }

    // An uncatalogued tool (MCP tools, todowrite, future provider extensions):
    // render a generic labeled row from its native payload instead of forcing it
    // into the shell "Run" grammar (which mislabels it with a terminal glyph).
    // Only reached for `command`-kind steps — `file`-kind returns above — so this
    // never touches recognized file/shell tools (they all resolve a `map`).
    if (tool && !map) {
      const fileBase = filePath ? basename(filePath) : null;
      // Name-bearing inputs give the generic row a real target — a bare "Skill"
      // row (user-reported) becomes "Skill fast-installs".
      const named = pickString(input, ["name", "skill", "skill_name", "id", "query", "description"]);
      return {
        ...base,
        verb: humanizeTool(tool),
        target: fileBase ?? named ?? "",
        monoTarget: Boolean(fileBase),
        glyph: "task",
        base: fileBase,
        detail: cmd.output,
        exitCode: cmd.exitCode,
        durationMs: cmd.durationMs,
        isError: cmdError,
      };
    }

    // Everything else runs on the shell.
    return {
      ...base,
      verb: map?.verb ?? "Run",
      target: cmd.command,
      monoTarget: true,
      glyph: map?.glyph ?? "run",
      detail: cmd.output,
      exitCode: cmd.exitCode,
      durationMs: cmd.durationMs,
      isError: cmdError,
    };
  }

  // 6. Fallback: agent narration / thinking text.
  return base;
}

/** Prettify an uncatalogued tool name into a human verb: strip any
 * `mcp__server__` / dotted namespace, spacing out `_`/`-`, Title-case the head.
 * `mcp__github__create_issue` → "Create issue"; falls back to "Tool". */
function humanizeTool(tool: string): string {
  const leaf = tool.split(/__|[./]/).filter(Boolean).pop() ?? tool;
  const words = leaf.replace(/[_-]+/g, " ").trim();
  if (!words) return "Tool";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Native-OpenCode identity and subagent attribution live in `./subagents` — a
// dedicated single-purpose module that folds this step projection into the
// parent/child card structure the Agents rail and subagent pane render. It reuses
// `asRecord`/`parseStepCode`/`deriveTrace` from here; the dependency flows one way.

// ── Todos (opencode `todowrite` tool) ───────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** One plan item from a `todowrite` tool call. */
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const TODO_STATUS = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

function normalizeTodoStatus(value: unknown): TodoStatus {
  return typeof value === "string" && TODO_STATUS.has(value as TodoStatus)
    ? (value as TodoStatus)
    : "pending";
}

/**
 * Parse a `todowrite` step's plan into typed todo items — the checklist the
 * agent is working through. Returns null for any other step (so a caller can
 * fall back to the normal trace row) or when the payload carries no items.
 */
export function parseTodos(step: ApiStep): TodoItem[] | null {
  const code = asRecord(parseStepCode(step));
  if (pickString(code, ["tool"])?.toLowerCase() !== "todowrite") return null;
  const raw = asRecord(code?.input)?.todos;
  if (!Array.isArray(raw)) return null;
  const items: TodoItem[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    const content = pickString(rec, ["content", "title", "text"]);
    if (!content) continue;
    items.push({ content, status: normalizeTodoStatus(rec?.status) });
  }
  return items.length > 0 ? items : null;
}
