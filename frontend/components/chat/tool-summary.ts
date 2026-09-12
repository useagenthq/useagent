// The ONE place a tool step becomes the line a person reads for it. Every tool
// row, the folded work log and the live "Working, <step>" status draw their
// title from here, so a raw payload never becomes a title anywhere.
//
// A step's result arrives in whatever shape the engine gave it: an MCP result
// (`{"result":{"content":[{"type":"text","text":...}]}}`), a shell wrapper
// (`{"formatted_output":"..."}`), plain text, or something unknown. The row
// title is the tool's human verb + object (or the command line itself for a
// shell step) and the detail is the first meaningful line of the unwrapped
// result. Unknown shapes fall back to the tool name; the full payload stays
// behind the row's expand disclosure, untouched.

import {
  type ApiStep,
  asRecord,
  deriveTrace,
  firstLine,
  parseStepCode,
  type StepTrace,
  toolLeafName,
} from "./types";

export interface ToolSummary {
  /** The row title: a human verb + object, or the command line for a shell step. */
  readonly label: string;
  /** The first meaningful line of the tool's result; null when it produced none. */
  readonly detail: string | null;
  /** The command line when the step ran on the shell (the row is a command row). */
  readonly command: string | null;
}

const LABEL_MAX = 96;
const DETAIL_MAX = 160;

/** Tool names that mean "run this on the shell" across engines. */
const SHELL_TOOLS = new Set(["bash", "shell", "execute", "command_execution"]);


function clip(text: string, max: number): string {
  const line = text.trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ── Result unwrapping ────────────────────────────────────────────────────────

const TEXT_KEYS = ["formatted_output", "output", "stdout", "text", "message"] as const;

function unwrapValue(value: unknown, depth: number): string | null {
  if (depth > 4) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const texts = value
      .map((item) => unwrapValue(item, depth + 1))
      .filter((text): text is string => text !== null);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  // MCP content blocks: only text blocks carry something readable.
  if (typeof record.type === "string" && record.type !== "text") return null;
  for (const key of ["result", "content"]) {
    if (key in record) {
      const nested = unwrapValue(record[key], depth + 1);
      if (nested) return nested;
    }
  }
  for (const key of TEXT_KEYS) {
    const text = str(record[key]);
    if (text) return text;
  }
  return null;
}

/** The engine slices long results, so a JSON payload often arrives cut off and
 *  no longer parses. Pull the first readable string value out of it instead of
 *  showing the broken JSON. */
function salvageTruncatedJson(raw: string): string | null {
  const match = /"(?:text|formatted_output|output|stdout|message)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(
    raw,
  );
  if (!match?.[1]) return null;
  try {
    return (JSON.parse(`"${match[1]}"`) as string).trim() || null;
  } catch {
    return match[1].replace(/\\n/g, "\n").trim() || null;
  }
}

/** Unwrap a tool result to the text a person would read. Plain text passes
 *  through; JSON in a known shape unwraps to its text; JSON in an unknown
 *  shape gives null (never the JSON itself). */
export function unwrapToolOutput(output: string | null | undefined): string | null {
  if (!output) return null;
  const trimmed = output.trim();
  if (!trimmed) return null;
  if (!/^[[{]/.test(trimmed)) return trimmed;
  try {
    return unwrapValue(JSON.parse(trimmed), 0);
  } catch {
    return salvageTruncatedJson(trimmed);
  }
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** The human line for a gateway/product tool, or null when the name is not one. */
function describeKnownTool(name: string, args: Record<string, unknown> | null): string | null {
  const query = str(args?.query);
  const named = str(args?.name) ?? str(args?.skill) ?? str(args?.skill_name) ?? str(args?.id);
  switch (name.toLowerCase()) {
    case "memory_search":
    case "memory_read":
      return "Recalled memory";
    case "memory_remember":
      return "Remembered";
    case "memory_correct":
      return "Corrected memory";
    case "memory_forget":
      return "Forgot memory";
    case "skill":
    case "skill_activate":
    case "skills_activate":
      return named ? `Activated playbook: ${named}` : "Activated playbook";
    case "skill_list":
    case "skills_list":
    case "skill_search":
    case "skills_search":
      return query ? `Searched playbooks for ${query}` : "Searched playbooks";
    case "gateway_tools_search":
      return query ? `Searched tools for ${query}` : "Searched tools";
    case "gateway_tool_describe":
      return named ? `Described tool ${named}` : "Described a tool";
    case "websearch":
    case "web_search":
      return query ? `Searched the web for ${query}` : "Searched the web";
    case "webfetch":
    case "web_fetch":
    case "fetch": {
      const url = str(args?.url);
      return url ? `Fetched ${url}` : "Fetched a page";
    }
    default:
      return null;
  }
}

/** The command a shell step ran, from its input (string or argv) or payload. A
 *  shell-grammar step with no recorded command falls back to its label, unless
 *  that label is just the tool's own title (an ACP "Execute" with no command). */
function shellCommand(
  trace: StepTrace,
  code: Record<string, unknown> | null,
  input: Record<string, unknown> | null,
  leaf: string | null,
): string | null {
  const raw = input?.command ?? code?.command;
  if (Array.isArray(raw)) {
    const argv = raw.filter((part): part is string => typeof part === "string");
    return argv.length > 0 ? argv.join(" ") : null;
  }
  const explicit = str(raw);
  if (explicit) return explicit;
  const target = trace.glyph === "run" ? str(trace.target) : null;
  return target && target.toLowerCase() !== leaf?.toLowerCase() ? target : null;
}

function shellLabel(command: string, trace: StepTrace): string {
  const line = clip(firstLine(command) || command, LABEL_MAX);
  if (trace.exitCode !== null && trace.exitCode !== 0) return `${line} (exit ${trace.exitCode})`;
  if (trace.isError) return `${line} (failed)`;
  return line;
}

/** Last-resort title when the trace grammar has no verb for a step (child-
 *  session/task receipts, label-less steps): the tool, the task's own naming
 *  fields, then the step kind. Never empty. */
function structuralLabel(
  step: ApiStep,
  code: Record<string, unknown> | null,
  input: Record<string, unknown> | null,
): string {
  return (
    str(code?.tool) ??
    str(input?.name) ??
    str(input?.agent) ??
    str(input?.description) ??
    str(input?.prompt) ??
    step.kind
  );
}

/**
 * Summarize one tool step into `{ label, detail }`. Pure; re-derived from
 * `code_json` on every call so an in-place step update reads its new result.
 */
export function summarizeToolStep(step: ApiStep): ToolSummary {
  const trace = deriveTrace(step);
  const code = asRecord(parseStepCode(step));
  const input = asRecord(code?.input);
  const text = unwrapToolOutput(trace.detail);
  const detail = text ? clip(firstLine(text), DETAIL_MAX) || null : null;

  const rawTool = str(code?.tool);
  const leaf = rawTool ? toolLeafName(rawTool) : null;
  // The gateway's compact bridge (`gateway_tool_call`) carries the real tool as
  // `input.name` + `input.arguments`; recognized by shape, whatever the engine
  // titled the call.
  const bridgedArgs = str(input?.name) ? asRecord(input?.arguments) : null;
  const args = bridgedArgs ?? input;
  const candidates = [bridgedArgs ? str(input?.name) : null, leaf, str(input?.name)];
  for (const candidate of candidates) {
    const known = candidate ? describeKnownTool(candidate, args) : null;
    if (known) return { label: clip(known, LABEL_MAX), detail, command: null };
  }

  const shell = trace.glyph === "run" || (leaf !== null && SHELL_TOOLS.has(leaf.toLowerCase()));
  const command = shell ? shellCommand(trace, code, input, leaf) : null;
  if (command) return { label: shellLabel(command, trace), detail, command };

  const verb = trace.verb.trim();
  const target = trace.target.trim();
  // Narration-like rows (sandbox boot, reasoning, a subagent's brief, the
  // adapter's "Thinking" placeholder) keep the verb as the title; their target is
  // prose and reads as the detail line.
  if (
    trace.glyph === "boot" ||
    trace.glyph === "reasoning" ||
    trace.glyph === "subagent" ||
    verb === "Thinking"
  ) {
    return {
      label: verb || structuralLabel(step, code, input),
      detail: detail ?? (target ? clip(target, DETAIL_MAX) : null),
      command: null,
    };
  }
  const label = verb ? (target ? `${verb} ${target}` : verb) : structuralLabel(step, code, input);
  return { label: clip(label, LABEL_MAX), detail, command: null };
}
