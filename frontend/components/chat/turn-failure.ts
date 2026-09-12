// The terminal failure of a settled turn, for the trace. The backend splits a
// failure in two: the done step carries only the category ("Engine error",
// "Timed out after 180s") and run.summary carries the reason (the "error: ..."
// line, already sliced server-side). This pairs them back up so the trace can
// head with the category and show every character of the reason it was given.
// A deliberate user stop is a neutral outcome, never a failure.

import { isUserStopSummary } from "@/components/session-ui/thread-error-banner";
import type { TraceStepRow } from "./turn-trace-model";
import { type ApiStep, firstLine, type RunStatus } from "./types";

export interface TurnFailure {
  /** The done step's category; a fallback when the step never landed. */
  readonly label: string;
  /** run.summary, verbatim. */
  readonly reason: string;
}

export function turnFailure(turn: {
  status: RunStatus;
  summary: string | null;
  steps: readonly ApiStep[];
}): TurnFailure | null {
  if (turn.status !== "failed" || !turn.summary || isUserStopSummary(turn.summary)) return null;
  const done = turn.steps.findLast((step) => step.kind === "done");
  return { label: done?.label ?? "Run failed", reason: turn.summary };
}

/** The trace's terminal row for a failed run: an x, the category, the reason
 *  as its detail, and the verbatim reason (with copy) once opened. */
export function failureRow(failure: TurnFailure): TraceStepRow {
  return {
    kind: "step",
    key: "failure",
    family: "boot",
    label: failure.label,
    chip: null,
    detail: firstLine(failure.reason),
    status: "failed",
    body: { kind: "failure", reason: failure.reason },
  };
}
