"use client";

// The trace's two work-log controls: collapse or expand every expandable step
// of the turn at once, and jump to the first failed step. The model helpers
// beside the bar keep the toggle state pure and testable without a DOM; the
// bar itself owns no state (the containing TurnTrace does, through
// useTurnUiState, so the choices survive virtualization). Control grammar from
// the changed-files tree's collapse-all button, on our semantic tokens.

import { RiContractUpDownLine, RiErrorWarningLine, RiExpandUpDownLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import type { TraceRow } from "./turn-trace-model";

/** Rows revealed on each side of the jumped error. Jumping must never unbound
 *  the fold: on a 10,000-step trace, one click used to mount every row (and,
 *  after Expand all, every payload too). The window is symmetric and bounded,
 *  with the row grammar's own "Show N steps" affordances covering the rest. */
export const ERROR_REVEAL_ROWS = 24;

/** What the controls act on: which steps can open a payload, and the first
 *  failed one, if any. */
export interface TraceControlsModel {
  readonly expandableKeys: readonly string[];
  readonly firstFailedKey: string | null;
}

export function traceControlsModel(rows: readonly TraceRow[]): TraceControlsModel {
  const expandableKeys: string[] = [];
  let firstFailedKey: string | null = null;
  for (const row of rows) {
    if (row.kind !== "step") continue;
    if (row.body !== null) expandableKeys.push(row.key);
    if (firstFailedKey === null && row.status === "failed") firstFailedKey = row.key;
  }
  return { expandableKeys, firstFailedKey };
}

/** The all-toggle's state: true once any expandable step is open. */
export function anyStepExpanded(
  expansion: Readonly<Record<string, boolean>>,
  model: TraceControlsModel,
): boolean {
  return model.expandableKeys.some((key) => expansion[key] === true);
}

/** The expansion map after every expandable step is set to one state. */
export function applyAllSteps(
  expansion: Readonly<Record<string, boolean>>,
  model: TraceControlsModel,
  value: boolean,
): Record<string, boolean> {
  const next = { ...expansion };
  for (const key of model.expandableKeys) next[key] = value;
  return next;
}

/** The bounded reveal window around the failed row `failedKey`: at most
 *  `contextRows` steps of context on each side, clamped to the row range.
 *  Pure so the bounds stay testable without a DOM. Returns null when the key
 *  is not in `rows` (nothing to reveal). */
export function boundedErrorReveal(
  rows: readonly TraceRow[],
  failedKey: string,
  contextRows: number = ERROR_REVEAL_ROWS,
): { from: number; to: number } | null {
  const index = rows.findIndex((row) => row.key === failedKey);
  if (index < 0) return null;
  return {
    from: Math.max(0, index - contextRows),
    to: Math.min(rows.length, index + 1 + contextRows),
  };
}

/** The reveal window after one "Show N later steps" click: the same window
 *  extended by one bounded chunk, never past the trace's edge. Walking to the
 *  end is many bounded clicks, never one unbounded render. Pure for the same
 *  reason as `boundedErrorReveal`. */
export function extendRevealForward(
  current: { from: number; to: number },
  total: number,
  chunk: number = ERROR_REVEAL_ROWS,
): { from: number; to: number } {
  return { from: current.from, to: Math.min(total, current.to + chunk) };
}

/** "Collapse all / Expand all" plus "Jump to error". Each control renders only
 *  when it has something to do: the all-toggle when the turn has an expandable
 *  step (a failure-only trace with no payloads gets no no-op button), the jump
 *  when the caller found a failed step. Both are real buttons with accessible
 *  names, so they are keyboard reachable by tab order. */
export function TraceControlsBar({
  anyExpanded,
  canToggleAll,
  canJump,
  onToggleAll,
  onJumpToError,
}: {
  anyExpanded: boolean;
  canToggleAll: boolean;
  canJump: boolean;
  onToggleAll: () => void;
  onJumpToError: () => void;
}) {
  return (
    <div data-testid="trace-controls" className="flex items-center gap-2">
      {canToggleAll && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={anyExpanded ? "Collapse all steps" : "Expand all steps"}
          onClick={onToggleAll}
          leadingIcon={anyExpanded ? RiContractUpDownLine : RiExpandUpDownLine}
        >
          {anyExpanded ? "Collapse all" : "Expand all"}
        </Button>
      )}
      {canJump && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label="Jump to first error"
          onClick={onJumpToError}
          leadingIcon={RiErrorWarningLine}
        >
          Jump to error
        </Button>
      )}
    </div>
  );
}
