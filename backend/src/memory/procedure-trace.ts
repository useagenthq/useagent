import type { ProcedureTraceStep, StepKind } from "../db/schema";
import type { SecretRedactor } from "../secrets/redact";

// ---------------------------------------------------------------------------
// Procedure trace (learning lane): the ORDERED, BOUNDED executable trace of a
// run, distilled from its durable step rows. Where capture-evidence.ts records
// tool COUNTS (the outcome shape), this records the tool SEQUENCE — which tool
// ran, against what target, and whether it terminally succeeded — so an
// accepted knowledge draft can later assemble a real playbook instead of
// "search knowledge and apply the same approach". Pure: the DB read lives at
// the caller (learning/drafts.ts already reads the run's steps).
// ---------------------------------------------------------------------------

/** Hard bounds: the trace is a capped slice of the evidence jsonb, never the
 *  full event log. Elisions are counted honestly ("... N more steps"). */
export const MAX_TRACE_STEPS = 40;
export const MAX_GIST_CHARS = 160;
const MAX_TOOL_CHARS = 40;

/** The slice of a durable step row the trace is built from. */
export interface TraceSourceStep {
  kind: StepKind;
  label: string;
  chip: string | null;
  codeJson: string | null;
}

export interface ProcedureTrace {
  steps: ProcedureTraceStep[];
  /** Steps beyond {@link MAX_TRACE_STEPS}, dropped from the tail. */
  elided: number;
}

/** The step payload fields the trace reads (adapters store more; see
 *  engines/acp-tool-step.ts and opencode-server.ts toolStep). */
interface StepCode {
  tool?: unknown;
  title?: unknown;
  input?: unknown;
  error?: unknown;
  status?: unknown;
}

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

function parseCode(codeJson: string | null): StepCode {
  if (!codeJson) return {};
  try {
    const parsed: unknown = JSON.parse(codeJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as StepCode)
      : {};
  } catch {
    return {};
  }
}

/** One line, single-spaced, capped. */
function oneLine(value: string, cap: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, cap).trim();
}

/** The step's target gist, most-specific first: the command line, the file
 *  path, the subagent description, then the adapter's title/label. Every
 *  candidate is a stable argument (path/command/name) — never raw output. */
function gistOf(code: StepCode, label: string): string {
  const input =
    code.input && typeof code.input === "object" && !Array.isArray(code.input)
      ? (code.input as Record<string, unknown>)
      : {};
  return (
    readString(input.command) ??
    readString(input.filePath) ??
    readString(input.file_path) ??
    readString(input.path) ??
    readString(input.abs_path) ??
    readString(input.description) ??
    readString(code.title) ??
    label
  );
}

/**
 * Build the ordered procedure trace from a run's step rows (already in idx
 * order; the terminal `done` marker is excluded). Each entry records the tool
 * name, a one-line redacted gist of its target, and the terminal outcome
 * (`ok=false` when the adapter recorded a tool error). Bounded to
 * {@link MAX_TRACE_STEPS} entries of {@link MAX_GIST_CHARS} chars. Pure.
 */
export function buildProcedureTrace(
  rows: readonly TraceSourceStep[],
  redact: SecretRedactor,
): ProcedureTrace {
  const toolRows = rows.filter((r) => r.kind !== "done");
  const kept = toolRows.slice(0, MAX_TRACE_STEPS);
  return {
    steps: kept.map((row) => {
      const code = parseCode(row.codeJson);
      return {
        tool: oneLine(readString(code.tool) ?? row.chip ?? row.kind, MAX_TOOL_CHARS),
        gist: oneLine(redact.text(gistOf(code, row.label)), MAX_GIST_CHARS),
        ok: code.error !== true && code.status !== "failed",
      };
    }),
    elided: toolRows.length - kept.length,
  };
}
