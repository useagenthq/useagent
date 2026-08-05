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
  { id: "claude", label: "Claude Code", hint: "cloud sandbox" },
  { id: "codex", label: "Codex", hint: "cloud sandbox" },
];

export function engineLabel(id: EngineId): string {
  return ENGINES.find((e) => e.id === id)?.label ?? id;
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
    if (typeof obj.command === "string" && obj.command.trim())
      command = obj.command;
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
  for (const key of ["path", "file", "filename", "file_path"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
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
    const body = ["content", "code", "diff"]
      .map((k) => item[k])
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
