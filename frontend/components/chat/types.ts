// Small parse helpers + view types for the coding-session surface. The run/step
// WIRE TYPES (ApiRun, ApiStep, StepKind, RunStatus, EngineId, MemoryScope,
// RunUpload) are the shared agent-client contract - imported here (and re-exported
// so this module's many consumers keep one path) instead of hand-copied, so the
// backend serializer and this UI cannot drift. The view types + parsers below are
// frontend-only and stay local.

import {
  decodeApiRun,
  type ApiRun,
  type ApiStep,
  type EngineId,
  type MemoryScope,
  type RunStatus,
  type RunUpload,
  type StepKind,
} from "@useagent/agent-client/wire";
import { providerDisplayName } from "./provider-display";

export type {
  ApiRun,
  ApiStep,
  EngineId,
  MemoryScope,
  RunStatus,
  RunUpload,
  StepKind,
};

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
    if (Array.isArray(thread)) {
      return thread.map(decodeApiRun).filter((run): run is ApiRun => run !== null);
    }
    const run = decodeApiRun(data);
    if (run) return [run];
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

// Display metadata for user-facing engines, in display order (opencode default).
// This is a CATALOG, not the selectable set: the composer offers only engines the
// SERVER reports enabled (GET /api/config -> `engines`, gated by ENABLED_ENGINES).
// claude/codex run via the resident-ACP adapters (native-binary install verified,
// #127) but stay OFF by default for SaaS safety, so they surface only when a
// backend enabled them. The legacy ids ("mock","claude-sdk","daytona","acp") stay
// in the EngineId union so old rows still type but never render as a choice.
export const ENGINES: { id: EngineId; label: string; hint: string }[] = [
  { id: "opencode", label: "OpenCode", hint: "any model · cloud sandbox" },
  { id: "chat", label: "Chat", hint: "direct model · no sandbox" },
  { id: "claude", label: "Claude Code", hint: "Anthropic agent · ACP" },
  { id: "codex", label: "Codex", hint: "OpenAI agent · ACP" },
  { id: "pi", label: "Pi", hint: "native Pi harness · cloud sandbox" },
];

export function engineLabel(id: EngineId): string {
  return ENGINES.find((e) => e.id === id)?.label ?? id;
}

/** The curated model set (single source of truth for every picker). Bare ids →
 * Anthropic direct; provider/model ids → OpenRouter. */
export const MODELS: { value: string; label: string; tint: string }[] = [
  { value: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna · Fast", tint: "text-sky-500" },
  {
    value: "moonshotai/kimi-k3",
    label: "Kimi K3",
    tint: "text-fuchsia-500",
  },
  {
    value: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash · Wafer Fast",
    tint: "text-cyan-500",
  },
  {
    value: "google/gemini-3.7-flash",
    label: "Gemini 3.7 Flash · Fast",
    tint: "text-blue-500",
  },
  { value: "claude-opus-5", label: "Opus 5", tint: "text-orange-500" },
  { value: "claude-sonnet-5", label: "Sonnet 5", tint: "text-blue-500" },
  { value: "claude-fable-5", label: "Fable 5", tint: "text-purple-500" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5", tint: "text-green-500" },
  { value: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", tint: "text-teal-500" },
  { value: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", tint: "text-amber-500" },
];

/** Codex model ids are the backend-policy ids accepted by the Codex runner. */
export const CODEX_MODELS: { value: string; label: string; tint: string }[] = [
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna · Fast", tint: "text-sky-500" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", tint: "text-amber-500" },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", tint: "text-teal-500" },
];

export const CHAT_MODELS: { value: string; label: string; tint: string }[] = [
  {
    value: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    tint: "text-blue-500",
  },
  {
    value: "anthropic/claude-opus-4.8",
    label: "Claude Opus 4.8",
    tint: "text-orange-500",
  },
  {
    value: "anthropic/claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    tint: "text-green-500",
  },
  { value: "z-ai/glm-5.2", label: "GLM 5.2", tint: "text-purple-500" },
];

export type ModelOption = { value: string; label: string; tint: string };

export function selectableModelsForEngine(engine: EngineId): ModelOption[] {
  const normalized = normalizeEngine(engine);
  if (normalized === "opencode") return MODELS;
  if (normalized === "pi") return MODELS;
  if (normalized === "codex") return CODEX_MODELS;
  if (normalized === "chat") return CHAT_MODELS;
  return [];
}

/**
 * Pre-session model-selection capability. The durable `session.started`
 * capability map remains authoritative once it arrives; this catalog-backed
 * fallback keeps the picker usable while a new native session is booting.
 */
export function supportsPreSessionModelSelection(engine: EngineId): boolean {
  return selectableModelsForEngine(engine).length > 0;
}

export function modelOptionsForEngine(
  engine: EngineId,
  allowedModelIds?: readonly string[],
): ModelOption[] {
  const known = selectableModelsForEngine(engine);
  if (known.length === 0) return [];
  if (!allowedModelIds) return known;
  return allowedModelIds.map(
    (value) =>
      known.find((model) => model.value === value) ?? {
        value,
        label: value,
        tint: "text-text-secondary",
      },
  );
}

export function modelLabel(value: string, engine: EngineId = "opencode"): string {
  return selectableModelsForEngine(engine).find((m) => m.value === value)?.label ?? value;
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

const TRANSPORT_PLACEHOLDER_LABELS = new Set([
  "dynamic tool call",
  "mcp tool call",
  "tool",
  "tool started",
  "tool updated",
]);

const TRANSPORT_TOOL_NAMES = new Set(["dynamic_tool_call", "mcp_tool_call", "tool", "unknown"]);

/**
 * Durable runs can contain provider transport receipts that are useful for raw
 * event replay but not meaningful product timeline rows. Keep semantic tool
 * calls, errors, and outputs; drop only empty T3 wrappers such as a bare
 * "Mcp tool call" with no server/tool identity.
 */
export function isRenderableTimelineStep(step: ApiStep): boolean {
  const code = asRecord(parseStepCode(step));
  if (code?.source !== "t3") return true;
  const activityKind = pickString(code, ["activityKind"]);
  if (!activityKind?.startsWith("tool.")) return true;

  const label = step.label.trim().toLowerCase();
  if (!TRANSPORT_PLACEHOLDER_LABELS.has(label)) return true;

  const tool = pickString(code, ["tool"])?.toLowerCase();
  const server = pickString(code, ["server"]);
  const output = pickString(code, ["output", "stdout"]);
  const native = asRecord(code.native);
  const activity = asRecord(native?.activity);
  const itemType = pickString(activity, ["itemType"])?.toLowerCase();
  const transportTool = tool ? TRANSPORT_TOOL_NAMES.has(tool) : false;
  const transportItem = itemType === "dynamic_tool_call" || itemType === "mcp_tool_call";

  return Boolean(server || output || (!transportTool && !transportItem));
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
    if (typeof obj.command === "string" && obj.command.trim()) command = obj.command;
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

/** A lifecycle stage should advance within ~2s during genuine startup. */
export const STALLED_STAGE_THRESHOLD_MS = 2_000;

/**
 * Elapsed-time affordance for a lifecycle stage that has stalled. Once a stage has
 * been the current one LONGER than the threshold (2s), its indicator shows
 * whole-second elapsed time ("4s") instead of an open-ended spinner, so a stuck
 * boundary reads as honest progress rather than a generic infinite "Working". Below
 * the threshold there is no affordance yet (returns null). Pure + testable.
 */
export function stalledStageElapsed(elapsedMs: number): string | null {
  if (!(elapsedMs >= STALLED_STAGE_THRESHOLD_MS)) return null;
  return `${Math.floor(elapsedMs / 1000)}s`;
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
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pickString(obj: Record<string, unknown> | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function pickNestedString(
  obj: Record<string, unknown> | null,
  path: readonly string[],
): string | null {
  let current: unknown = obj;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return null;
    current = record[key];
  }
  return typeof current === "string" && current.trim() ? current : null;
}

function semanticToolName(
  tool: string,
  code: Record<string, unknown> | null,
  input: Record<string, unknown> | null,
): string {
  const normalized = tool.toLowerCase();
  if (!TRANSPORT_TOOL_NAMES.has(normalized)) return tool;
  return (
    pickString(code, ["name", "toolName", "tool_name", "method", "functionName"]) ??
    pickNestedString(code, ["function", "name"]) ??
    pickString(input, ["name", "toolName", "tool_name", "method", "functionName"]) ??
    tool
  );
}

function semanticServerName(
  code: Record<string, unknown> | null,
  input: Record<string, unknown> | null,
): string | null {
  return (
    pickString(code, ["server", "serverName", "server_name", "mcpServer"]) ??
    pickString(input, ["server", "serverName", "server_name", "mcpServer"])
  );
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
function diffStat(input: Record<string, unknown> | null): { adds: number; dels: number } | null {
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
      pickString(input, ["description"]) ?? prompt ?? label.replace(/^Subagent\s*—\s*/, "");
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
    if (
      map &&
      filePath &&
      (map.glyph === "read" || map.glyph === "search" || map.glyph === "list")
    ) {
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
      const displayTool = semanticToolName(tool, code, input);
      const server = providerDisplayName(semanticServerName(code, input));
      // Name-bearing inputs give the generic row a real target (user-reported): a bare "Skill" becomes "Skill fast-installs".
      const named = pickString(input, [
        "name",
        "skill",
        "skill_name",
        "id",
        "query",
        "description",
      ]);
      return {
        ...base,
        verb: humanizeTool(displayTool),
        target: server ?? fileBase ?? (displayTool === tool ? named : null) ?? "",
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
  const leaf =
    tool
      .split(/__|[./]/)
      .filter(Boolean)
      .pop() ?? tool;
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
  id: string;
  content: string;
  status: TodoStatus;
}

const TODO_STATUS = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"]);

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
  for (const [index, entry] of raw.entries()) {
    const rec = asRecord(entry);
    const content = pickString(rec, ["content", "title", "text"]);
    if (!content) continue;
    items.push({
      id: pickString(rec, ["id"]) ?? `${index}-${content}`,
      content,
      status: normalizeTodoStatus(rec?.status),
    });
  }
  return items.length > 0 ? items : null;
}
