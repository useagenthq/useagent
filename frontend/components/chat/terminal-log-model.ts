// The terminal Log tab's transcript: a run's tool steps compressed to what a
// person would read in a terminal. A shell step is `$ <command line>` and the
// readable text of its result (unwrapped from whatever JSON the engine wrapped it
// in), cut to the first lines with a "+K lines" tail, plus its exit code when it
// failed. Any other call (a gateway memory or playbook call, a file tool, an MCP
// tool) is one line from the summarizer and never its payload.

import { summarizeToolStep, unwrapToolOutput } from "./tool-summary";
import { type ApiStep, deriveTrace } from "./types";

/** Result lines a command shows before folding the rest behind "+K lines". */
export const LOG_BODY_MAX_LINES = 12;

export type TerminalLogEntry =
  | {
      readonly kind: "command";
      readonly key: string;
      readonly command: string;
      readonly lines: readonly string[];
      readonly hiddenLines: number;
      readonly exitCode: number | null;
      readonly failed: boolean;
      /** False while the step has neither output nor an exit: still in flight. */
      readonly settled: boolean;
    }
  | {
      readonly kind: "call";
      readonly key: string;
      readonly label: string;
      readonly detail: string | null;
      readonly failed: boolean;
    };

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function compressTerminalLog(
  steps: readonly ApiStep[],
  maxLines: number = LOG_BODY_MAX_LINES,
): TerminalLogEntry[] {
  const entries: TerminalLogEntry[] = [];
  for (const step of steps) {
    if (step.kind !== "command") continue;
    const summary = summarizeToolStep(step);
    const trace = deriveTrace(step);
    if (summary.command === null) {
      entries.push({
        kind: "call",
        key: step.id,
        label: lowerFirst(summary.label),
        detail: summary.detail,
        failed: trace.isError,
      });
      continue;
    }
    const text = unwrapToolOutput(trace.detail);
    const lines = text ? text.split("\n") : [];
    const shown = lines.slice(0, maxLines);
    entries.push({
      kind: "command",
      key: step.id,
      command: summary.command,
      lines: shown,
      hiddenLines: lines.length - shown.length,
      exitCode: trace.exitCode,
      failed: trace.isError,
      settled: trace.detail !== null || trace.exitCode !== null,
    });
  }
  return entries;
}
