"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/LegacySidebar.tsx (SidebarThreadRow row chrome)
//   + apps/web/src/components/Sidebar.logic.ts (resolveThreadRowClassName,
//     resolveThreadStatusPill, hasUnseenCompletion)
//   + apps/web/src/components/ThreadStatusIndicators.tsx (ThreadStatusLabel).
//
// Port notes:
// - Bound to OUR run summary shape (`SidebarRun`, i.e. GET /api/runs) through the
//   existing statusTone/TONE_TO_DOT maps - no second status model. Their
//   five-state pill collapses to what our runs carry today: Working (live,
//   pulsing dot), Failed (error - "the user must see the failure", never gated
//   on unread), and Completed as the unread affordance (settled after the last
//   visit). Resting rows stay unlabeled per their inbox-zero treatment.
// - lastVisited tracking is not in our canonical state yet, so `unread` is a
//   plain prop (default false) for the caller to supply when that truth lands.
// - Their TanStack router link -> next/link. Their Tooltip on pill/title ->
//   native `title` attribute (the pill label is always visible in our fixed
//   w-64 rail, so the responsive `hidden md:inline` collapse is dropped too).
// - Drag-reorder, inline rename, archive, multi-select, PR/terminal/worktree
//   indicators, env selectors, and electron branches skipped.
// - Their per-thread branch/jump chip becomes our git identity line: when the
//   run carries repos, a second row of T3GitChips (repo shortname + chosen
//   branch from `repo_specs`) renders under the title and the row trades its
//   fixed h-8 for a two-line py-1.5 layout.
// - T3 shadcn tokens -> AlignUI semantic tokens (sidebar-row-active/hover ->
//   bg-weak-50, sidebar-muted-foreground -> text-sub-600, secondary-label ->
//   text-soft-400); their rounded-md px-2 follows this rail's rounded-lg
//   px-2.5 rhythm; their h-1.5 status dot + animate-status-pulse -> the shared
//   StatusDot primitive.

import Link from "next/link";
import { memo } from "react";

import { statusTone, TONE_TO_DOT } from "@/app/agent/runs/runs-data";
import { type DotTone, StatusDot } from "@/components/shared/status-dot";
import type { SidebarRun } from "@/components/shell/working-project-status";
import { runGitRefs, T3GitChips } from "@/components/t3-ui/git-chip";
import { cn } from "@/utils/cn";
import { relativeTime } from "@/utils/format";

export interface T3ThreadRowPill {
  label: "Working" | "Failed" | "Completed";
  dot: { tone: DotTone; pulse?: boolean; hollow?: boolean };
  textClass: string;
}

/**
 * Upstream resolveThreadStatusPill, collapsed onto our run tones: color is
 * reserved for "in motion" (Working), "broken" (Failed), and the unread
 * completion affordance (Completed). Everything else rests unlabeled.
 */
export function resolveThreadRowPill(input: {
  status: string;
  unread?: boolean;
}): T3ThreadRowPill | null {
  const tone = statusTone(input.status);
  if (tone === "live") {
    return { label: "Working", dot: TONE_TO_DOT.live, textClass: "text-away-base" };
  }
  if (tone === "error") {
    return { label: "Failed", dot: TONE_TO_DOT.error, textClass: "text-error-base" };
  }
  if (tone === "success" && input.unread) {
    return { label: "Completed", dot: TONE_TO_DOT.success, textClass: "text-success-base" };
  }
  return null;
}

/** Upstream resolveThreadRowClassName: compact fixed-height rows, active rows
 * hold their fill, resting rows brighten on hover. Selection branch dropped
 * (no multi-select here). `gitLine` swaps the fixed h-8 single line for a
 * two-line column so the git identity chips fit under the title. */
export function resolveThreadRowClassName(input: { active: boolean; gitLine?: boolean }): string {
  const base = cn(
    "w-full cursor-pointer select-none rounded-lg px-2.5 text-label-sm transition-colors",
    input.gitLine
      ? "flex flex-col justify-center gap-0.5 py-1.5"
      : "flex h-8 items-center gap-1.5",
  );
  if (input.active) {
    return cn(base, "bg-bg-weak-50 font-medium text-text-strong-950");
  }
  return cn(base, "text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950");
}

/** Upstream trailing-meta timestamp pick (latest-activity first), on our wire
 * fields: updated_at then created_at, skipping malformed values. */
export function threadRowTimestamp(
  run: Pick<SidebarRun, "created_at" | "updated_at">,
): number | null {
  for (const value of [run.updated_at, run.created_at]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * The T3 sidebar thread row: `[status pill] Title… [time]` in a compact h-8
 * hover row. Purely presentational; feed it a run from the existing runs lane.
 */
export const T3ThreadRow = memo(function T3ThreadRow({
  run,
  href,
  active = false,
  unread = false,
}: {
  run: SidebarRun;
  href: string;
  active?: boolean;
  unread?: boolean;
}) {
  const pill = resolveThreadRowPill({ status: run.status, unread });
  const title = run.prompt || "Untitled run";
  const timestampMs = threadRowTimestamp(run);
  const gitRefs = runGitRefs(run);

  return (
    <Link
      href={href}
      data-t3-ui="thread-row"
      aria-current={active ? "page" : undefined}
      title={title}
      className={resolveThreadRowClassName({ active, gitLine: gitRefs.length > 0 })}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        {pill ? (
          <span
            className={cn("inline-flex shrink-0 items-center gap-1 text-[10px]", pill.textClass)}
          >
            <StatusDot {...pill.dot} />
            <span>{pill.label}</span>
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {timestampMs !== null ? (
          <span
            className={cn(
              "shrink-0 text-[10px] tabular-nums",
              active ? "text-text-strong-950" : "text-text-soft-400",
            )}
          >
            {relativeTime(timestampMs)}
          </span>
        ) : null}
      </span>
      {gitRefs.length > 0 ? <T3GitChips refs={gitRefs} /> : null}
    </Link>
  );
});
