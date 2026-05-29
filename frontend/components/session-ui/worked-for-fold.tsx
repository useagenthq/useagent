"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Sources:
//   apps/web/src/components/chat/MessagesTimeline.tsx      (TurnFoldTimelineRow:
//     the collapsed "Worked for Xs >" header row above a settled turn's work)
//   apps/web/src/components/chat/MessagesTimeline.logic.ts (deriveTurnFolds label
//     grammar: "Worked for {duration}" / "Worked" when no duration exists)
//
// Port notes: upstream folds by turnId over their TimelineEntry stream with a
// uiStateStore expandedTurnIds set; this port takes ONE completed work burst as
// canonical TimelineNode[] (the consecutive tool/step nodes between a user turn
// and its answer), owns the expanded flag locally, computes the duration from
// the nodes' own ApiStep timestamps, and renders the expanded body with the
// already-ported WorkEntryRow. Tokens are AlignUI semantic.

import { RiArrowDownSLine, RiArrowRightSLine } from "@remixicon/react";
import { memo, useMemo, useState } from "react";
import { type TimelineNode } from "@/components/chat/timeline";
import { workEntriesFromTimeline } from "./adapter";
import { formatWorkingTimer } from "./work-entry";
import { WorkEntryRow } from "./work-entry-row";

/**
 * Duration of a work burst from its own node timestamps: min -> max of the tool
 * nodes' ApiStep.created_at, formatted with the shared working-timer grammar.
 * Null when the burst carries no timestamped tool nodes (reasoning-only).
 */
export function workedForDuration(nodes: readonly TimelineNode[]): string | null {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    if (node.kind !== "tool") continue;
    const ms = Date.parse(node.step.created_at);
    if (!Number.isFinite(ms)) continue;
    if (ms < startMs) startMs = ms;
    if (ms > endMs) endMs = ms;
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return formatWorkingTimer(new Date(startMs).toISOString(), new Date(endMs).toISOString());
}

/** Upstream deriveTurnFolds label grammar for a settled turn. */
export function workedForLabel(duration: string | null): string {
  return duration ? `Worked for ${duration}` : "Worked";
}

/**
 * A settled turn's work burst folded behind a "Worked for Xs >" header row,
 * expandable in place to the full T3 work-entry list. Purely presentational;
 * feed it the consecutive tool/step nodes of ONE turn from the canonical lane.
 */
export const WorkedForFold = memo(function WorkedForFold({
  nodes,
  workspaceRoot,
  defaultExpanded = false,
}: {
  nodes: readonly TimelineNode[];
  workspaceRoot?: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const entries = useMemo(() => workEntriesFromTimeline(nodes, false), [nodes]);
  const duration = useMemo(() => workedForDuration(nodes), [nodes]);
  if (entries.length === 0) return null;

  const label = workedForLabel(duration);
  const Chevron = expanded ? RiArrowDownSLine : RiArrowRightSLine;

  return (
    <section
      data-session-ui="worked-for-fold"
      aria-label={label}
      className="border-b border-border-button-default pb-2 pt-1"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-[12px] leading-5 text-text-secondary tabular-nums transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
      >
        <span>{label}</span>
        <Chevron className="size-3.5 shrink-0" aria-hidden />
      </button>
      {expanded && (
        <div className="mt-1 space-y-px">
          {entries.map((entry) => (
            <WorkEntryRow key={entry.id} entry={entry} workspaceRoot={workspaceRoot} />
          ))}
        </div>
      )}
    </section>
  );
});
