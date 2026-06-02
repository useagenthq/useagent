"use client";

import { RiAddLine, RiArrowRightSLine, RiFolderLine } from "@remixicon/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { ThreadRow } from "@/components/session-ui/thread-row";
import { StatusDot } from "@/components/shared/status-dot";
import { cx } from "@/utils/cx";
import type { ProjectGroup } from "./sidebar-project-groups";
import { isSidebarActiveRun } from "./working-project-status";

// The recent few threads stay visible; the rest sit behind a per-project
// disclosure so a long history never floods the rail.
const VISIBLE_THREADS = 6;

/**
 * One collapsible project group in the thread rail: a folder-icon header with
 * the repo name and its live/count indicator, and (when expanded) its threads
 * nested beneath a connecting tree line, each rendered with the shared
 * `ThreadRow` (title + relative time, active-state highlight). The repo chips
 * are dropped on the nested rows since the group header already names the repo.
 *
 * Expanded/collapsed state is owned by the parent (SidebarProjects) so it can be
 * remembered per project; the inner "Show N more" cap is local.
 */
export function ProjectThreadGroup({
  group,
  expanded,
  onToggle,
}: {
  group: ProjectGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  const pathname = usePathname();
  const [showAll, setShowAll] = useState(false);
  const hasThreads = group.threads.length > 0;

  // A repo with no threads yet is a plain shortcut to start one there - no
  // disclosure, since there is nothing to nest.
  if (!hasThreads) {
    return (
      <Link
        href={`/agent/new?repo=${encodeURIComponent(group.fullName ?? "")}`}
        className="group/proj flex items-center gap-2 rounded-2lg px-2.5 py-1.5 text-body-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover hover:text-text-primary"
      >
        <RiFolderLine className="size-3.5 shrink-0 text-foreground-icon-tertiary" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{group.name}</span>
        <RiAddLine
          className="size-3.5 shrink-0 text-foreground-icon-tertiary opacity-0 transition-opacity group-hover/proj:opacity-100"
          aria-hidden
        />
      </Link>
    );
  }

  const active = group.threads.some(isSidebarActiveRun);
  const visible = showAll ? group.threads : group.threads.slice(0, VISIBLE_THREADS);
  const overflow = group.threads.length - visible.length;

  return (
    <div>
      <div className="flex items-center">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-2lg px-2.5 py-1.5 text-body-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover hover:text-text-primary"
        >
          <RiArrowRightSLine
            className={cx(
              "size-3.5 shrink-0 text-foreground-icon-tertiary transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
          <RiFolderLine className="size-3.5 shrink-0 text-foreground-icon-tertiary" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left">{group.name}</span>
          {active ? (
            <StatusDot tone="away" pulse />
          ) : (
            <span className="shrink-0 text-caption-1-regular tabular-nums text-text-tertiary">
              {group.threads.length}
            </span>
          )}
        </button>
        {group.fullName ? (
          <Link
            href={`/agent/new?repo=${encodeURIComponent(group.fullName)}`}
            aria-label={`New thread in ${group.name}`}
            className="shrink-0 rounded-2lg p-1 text-foreground-icon-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-primary"
          >
            <RiAddLine className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
      {expanded ? (
        <ul
          aria-label={`Threads in ${group.name}`}
          className="ml-[1.05rem] flex flex-col border-l border-border-button-default pl-1.5"
        >
          {visible.map((run) => {
            const href = `/session/${run.id}`;
            return (
              <li key={run.id}>
                <ThreadRow run={run} href={href} active={pathname === href} hideGitRefs />
              </li>
            );
          })}
          {overflow > 0 || showAll ? (
            <li>
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="flex w-full items-center gap-1 rounded-lg px-2.5 py-1 text-caption-1-regular text-text-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-secondary"
              >
                {showAll ? "Show fewer" : `Show ${overflow} more`}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
