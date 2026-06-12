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
// - Bound to OUR run summary shape (`SidebarRun`, i.e. GET /api/runs) through
//   the shared thread-discovery status model. Running is green, queued amber,
//   failed red, and completed rests without a dot.
// - Their TanStack router link -> next/link. Their Tooltip on pill/title ->
//   native `title` attribute (the pill label is always visible in our fixed
//   w-64 rail, so the responsive `hidden md:inline` collapse is dropped too).
// - Drag-reorder, inline rename, archive, multi-select, PR/terminal/worktree
//   indicators, env selectors, and electron branches skipped.
// - Their per-thread branch/jump chip becomes our git identity line: when the
//   run carries repos, a second row of GitChips (repo shortname + chosen
//   branch from `repo_specs`) renders under the title and the row trades its
//   fixed h-8 for a two-line py-1.5 layout.
// - T3 shadcn tokens -> our semantic tokens (sidebar-row-active/hover ->
//   bg-weak-50, sidebar-muted-foreground -> text-sub-600, secondary-label ->
//   text-soft-400); their rounded-md px-2 follows this rail's rounded-lg
//   px-2.5 rhythm; their h-1.5 status dot + animate-status-pulse -> the shared
//   StatusDot primitive.

import type { RunStatus } from "@useagent/agent-client/wire";
import Link from "next/link";
import { memo } from "react";
import { GitChips, runGitRefs } from "@/components/session-ui/git-chip";
import { type DotTone, StatusDot } from "@/components/shared/status-dot";
import {
  effectiveThreadStatus,
  threadActivityTimestamp,
  threadStatusPresentation,
} from "@/components/shell/thread-discovery";
import type { SidebarRun } from "@/components/shell/working-project-status";
import { cx as cn } from "@/utils/cx";
import { relativeTimeShort } from "@/utils/format";

export interface ThreadRowPill {
  label: "Running" | "Queued" | "Failed";
  dot: { tone: DotTone; pulse?: boolean; hollow?: boolean };
  textClass: string;
}

/**
 * Upstream row treatment collapsed onto the shared discovery statuses. Active
 * and failed states carry both a truthful dot and a non-color text label.
 */
export function resolveThreadRowPill(input: { status: RunStatus }): ThreadRowPill | null {
  const presentation = threadStatusPresentation(input.status);
  if (!presentation.dot) return null;
  const textClass =
    input.status === "running"
      ? "text-lime-600"
      : input.status === "queued"
        ? "text-orange-500"
        : "text-text-error-primary";
  const label =
    input.status === "running" ? "Running" : input.status === "queued" ? "Queued" : "Failed";
  return { label, dot: presentation.dot, textClass };
}

/** Upstream resolveThreadRowClassName: uniform 32px rows, active rows
 * hold their fill, resting rows brighten on hover. Selection branch dropped
 * (no multi-select here). `gitLine` swaps the fixed h-8 single line for a
 * two-line column so the git identity chips fit under the title. */
export function resolveThreadRowClassName(input: { active: boolean; gitLine?: boolean }): string {
  const base = cn(
    "w-full cursor-pointer select-none rounded-lg px-2.5 text-body-2-medium transition-colors",
    input.gitLine ? "flex flex-col justify-center gap-0.5 py-1.5" : "flex h-8 items-center gap-1.5",
  );
  if (input.active) {
    return cn(base, "bg-background-secondary-default font-medium text-text-primary");
  }
  return cn(base, "text-text-secondary hover:bg-background-primary-hover hover:text-text-primary");
}

/** Upstream trailing-meta timestamp pick (latest-activity first), on our wire
 * fields: updated_at then created_at, skipping malformed values. */
export function threadRowTimestamp(
  run: Pick<SidebarRun, "created_at" | "updated_at">,
): number | null {
  return threadActivityTimestamp(run);
}

/**
 * The T3 sidebar thread row: `[status pill] Title… [time]` in a uniform h-8
 * hover row. Purely presentational; feed it a run from the existing runs lane.
 */
export const ThreadRow = memo(function ThreadRow({
  run,
  href,
  active = false,
}: {
  run: SidebarRun;
  href: string;
  active?: boolean;
}) {
  const pill = resolveThreadRowPill({ status: effectiveThreadStatus(run) });
  const title = run.prompt || "Untitled run";
  const timestampMs = threadRowTimestamp(run);
  const gitRefs = runGitRefs(run);

  return (
    <Link
      href={href}
      data-session-ui="thread-row"
      aria-current={active ? "page" : undefined}
      title={title}
      className={resolveThreadRowClassName({ active, gitLine: gitRefs.length > 0 })}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        {pill ? (
          <span
            className={cn("inline-flex shrink-0 items-center gap-1 text-[10px]", pill.textClass)}
            role="img"
            aria-label={pill.label}
            title={pill.label}
          >
            <StatusDot {...pill.dot} />
            {/* Failed stays a quiet dot; only in-motion states carry a word. */}
            {pill.label !== "Failed" ? <span>{pill.label}</span> : null}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {timestampMs !== null ? (
          <span
            className={cn(
              "shrink-0 text-caption-1-medium tabular-nums",
              active ? "text-text-primary" : "text-text-tertiary",
            )}
          >
            {relativeTimeShort(timestampMs)}
          </span>
        ) : null}
      </span>
      {gitRefs.length > 0 ? <GitChips refs={gitRefs} /> : null}
    </Link>
  );
});
