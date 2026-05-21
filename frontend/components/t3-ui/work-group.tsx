"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Sources: apps/web/src/components/chat/MessagesTimeline.tsx (WorkGroupSection,
// WorkGroupToggleTimelineRow) + MessagesTimeline.logic.ts (the work-group overflow
// policy: collapsed groups keep the newest MAX_VISIBLE_WORK_LOG_ENTRIES rows behind
// a "+N previous tool calls" toggle).
//
// Port notes: upstream models the toggle as LegendList virtualizer rows keyed by a
// uiStateStore expandedWorkGroupIds set; this port owns the expanded flag locally
// (no store, no virtualizer) - the policy itself is the shared pure function
// groupWorkEntryOverflow in ./work-entry.ts. Tokens are AlignUI semantic.

import { RiArrowDownSLine } from "@remixicon/react";
import { memo, useState } from "react";
import { cn } from "@/utils/cn";
import {
  groupWorkEntryOverflow,
  MAX_VISIBLE_WORK_ENTRIES,
  type T3WorkEntry,
} from "./work-entry";
import { T3WorkEntryRow } from "./work-entry-row";

/**
 * One burst of work-log rows between assistant messages: renders the newest
 * `maxVisible` rows, folding the earlier ones behind "+N previous tool calls".
 */
export const T3WorkGroup = memo(function T3WorkGroup({
  entries,
  workspaceRoot,
  turnSettled = true,
  maxVisible = MAX_VISIBLE_WORK_ENTRIES,
}: {
  entries: readonly T3WorkEntry[];
  workspaceRoot?: string;
  turnSettled?: boolean;
  maxVisible?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const { visible, hiddenCount, onlyToolEntries } = groupWorkEntryOverflow(
    entries,
    expanded,
    maxVisible,
  );
  const shownCount = expanded ? visible.length : visible.length + hiddenCount;
  const groupLabel = onlyToolEntries
    ? shownCount === 1
      ? "1 tool call"
      : `${shownCount} tool calls`
    : "Work Log";

  if (visible.length === 0) return null;

  const labelNoun = onlyToolEntries
    ? hiddenCount === 1
      ? "tool call"
      : "tool calls"
    : hiddenCount === 1
      ? "log entry"
      : "log entries";

  return (
    <section data-t3-ui="work-group" className="-mx-1 space-y-0.5 px-1 py-0.5" aria-label={groupLabel}>
      {!onlyToolEntries && (
        <p className="px-0.5 pb-0.5 text-[11px] font-medium text-text-sub-600">{groupLabel}</p>
      )}
      <div className="space-y-px">
        {visible.map((entry) => (
          <T3WorkEntryRow
            key={entry.id}
            entry={entry}
            workspaceRoot={workspaceRoot}
            turnSettled={turnSettled}
          />
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-bg-weak-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-base"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-text-soft-400">
            <RiArrowDownSLine
              className={cn(
                "size-3.5 shrink-0 opacity-70 transition-transform duration-200",
                expanded && "rotate-180",
              )}
              aria-hidden
            />
          </span>
          {expanded ? (
            <span className="font-medium text-text-strong-950">
              Show fewer {onlyToolEntries ? "tool calls" : "log entries"}
            </span>
          ) : (
            <span className="font-medium text-text-strong-950">
              +{hiddenCount} previous {labelNoun}
            </span>
          )}
        </button>
      )}
    </section>
  );
});
