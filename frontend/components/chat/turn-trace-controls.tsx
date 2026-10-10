"use client";

// The trace's two work-log controls: collapse or expand every expandable step
// of the turn at once, and jump to the first failed step. The model helpers
// beside the bar keep the toggle state pure and testable without a DOM; the
// bar itself owns no state (the containing TurnTrace does, through
// useTurnUiState, so the choices survive virtualization). Control grammar from
// the changed-files tree's collapse-all button, on our semantic tokens.

import { RiContractUpDownLine, RiErrorWarningLine, RiExpandUpDownLine } from "@remixicon/react";
import { cx as cn } from "@/utils/cx";
import type { TraceRow } from "./turn-trace-model";

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

const CONTROL_CLASS =
  "flex min-h-7 w-fit cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] text-text-tertiary transition-colors hover:bg-background-primary-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring";

/** "Collapse all / Expand all" plus "Jump to error". The jump control renders
 *  only when the caller found a failed step; both are real buttons with
 *  accessible names, so they are keyboard reachable by tab order. */
export function TraceControlsBar({
  anyExpanded,
  canJump,
  onToggleAll,
  onJumpToError,
}: {
  anyExpanded: boolean;
  canJump: boolean;
  onToggleAll: () => void;
  onJumpToError: () => void;
}) {
  return (
    <div data-testid="trace-controls" className="flex items-center gap-2">
      <button
        type="button"
        aria-label={anyExpanded ? "Collapse all steps" : "Expand all steps"}
        onClick={onToggleAll}
        className={CONTROL_CLASS}
      >
        {anyExpanded ? (
          <RiContractUpDownLine className="size-3.5" aria-hidden />
        ) : (
          <RiExpandUpDownLine className="size-3.5" aria-hidden />
        )}
        <span>{anyExpanded ? "Collapse all" : "Expand all"}</span>
      </button>
      {canJump && (
        <button
          type="button"
          aria-label="Jump to first error"
          onClick={onJumpToError}
          className={cn(CONTROL_CLASS, "text-text-secondary")}
        >
          <RiErrorWarningLine className="size-3.5" aria-hidden />
          <span>Jump to error</span>
        </button>
      )}
    </div>
  );
}
