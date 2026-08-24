"use client";

// Tree treatment adapted from the Board UI Figma "ai_chat" sidebar:
// the Repositories tree whose folders expand into recent
// chats behind a curved connector, with folder->folder-open icons, a
// grid-rows 0fr->1fr height animation, and right-aligned relative-time chips.
// Only the tree section is vendored - our shell keeps its own nav, brand,
// search and account chrome.

import { RiFolderLine, RiFolderOpenLine } from "@remixicon/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";

import { cx } from "@/utils/cx";

const VISIBLE_THREADS_PER_PROJECT = 6;

/** A single thread row under a project folder. `time` is the pre-formatted
 *  relative-time chip (e.g. "34m ago"); `id` addresses the thread. */
export interface ProjectThread {
  id: string;
  label: string;
  time: string;
  isSelected?: boolean;
}

/** A project folder and its threads. `key` is the stable expansion identity;
 *  `fullName` is the clean "owner/name" for real repos (null for the
 *  no-project bucket) and drives the per-project actions. */
export interface ProjectGroup {
  key: string;
  label: string;
  fullName: string | null;
  threads: ProjectThread[];
}

/** Open/close control handed to the per-project menu so a right-click on the
 *  folder row and the hover kebab drive the same menu instance. */
export interface ProjectMenuControl {
  isOpen: boolean;
  setOpen: (open: boolean) => void;
}

/**
 * Curved tree connector (Figma "Vector 132"): a vertical guide dropping from
 * the folder icon with a rounded elbow into each thread row. Rows are a compact
 * 24px (h-6) with 2px gaps; the trunk sits at the icon's center (x 17.5 within
 * the list) and each elbow lands 8px to the right at the row's center - the
 * pitch tracks the row height so the elbows stay aligned.
 */
function TreeConnector({ count }: { count: number }) {
  const rowPitch = 26; // 24px row (h-6) + 2px gap
  const firstCenter = 12;
  const height = firstCenter + rowPitch * (count - 1) + 1;
  return (
    <svg
      aria-hidden
      width="12"
      height={height}
      viewBox={`0 0 12 ${height}`}
      fill="none"
      className="pointer-events-none absolute top-0 left-[16.5px] text-foreground-icon-quaternary"
    >
      <title>Project thread connector</title>
      {Array.from({ length: count }, (_, i) => {
        const y = firstCenter + rowPitch * i;
        return (
          <path
            key={y}
            d={`M0.5 0 V${y - 5} Q0.5 ${y} 5.5 ${y} H11.5`}
            stroke="currentColor"
            strokeWidth="1"
          />
        );
      })}
    </svg>
  );
}

/** Thread row under an open folder - indented 36px (pl aligns past the folder
 *  icon), a compact fixed 24px height (h-6), with a relative-time chip on the
 *  right. Navigates to the thread; the active thread holds its fill. */
function ThreadItem({
  thread,
  href,
  active,
  tabIndex,
}: {
  thread: ProjectThread;
  href: string;
  active: boolean;
  tabIndex?: number;
}) {
  return (
    <Link
      href={href}
      tabIndex={tabIndex}
      data-session-ui="thread-row"
      aria-current={active ? "page" : undefined}
      title={thread.label}
      className={cx(
        "flex h-6 w-full items-center gap-2 rounded-2lg pr-2 pl-9 transition-colors duration-150 ease",
        active ? "bg-background-secondary-hover" : "hover:bg-background-secondary-hover",
      )}
    >
      <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-secondary">
        {thread.label}
      </span>
      <span className="inline-flex shrink-0 items-center justify-center rounded-sm bg-background-tertiary-default px-1 py-px text-caption-1-medium whitespace-nowrap tabular-nums text-text-secondary">
        {thread.time}
      </span>
    </Link>
  );
}

/**
 * Expandable project folder: clicking the row toggles its threads
 * (folder -> folder-open, threads slide in below with the tree connector).
 * Expansion animates via the grid-rows 0fr->1fr trick so the list height eases
 * smoothly without measuring content. Expansion is controlled by the parent so
 * it can be remembered per project.
 *
 * The row owns the per-project menu open-state: the hover-revealed kebab (its
 * three-dots trigger) opens the menu supplied by `renderMenu`. Right-click is
 * left to the browser - the kebab is the single, discoverable trigger.
 */
function ProjectFolder({
  group,
  expanded,
  onToggle,
  threadHref,
  renderMenu,
}: {
  group: ProjectGroup;
  expanded: boolean;
  onToggle: (key: string) => void;
  threadHref: (thread: ProjectThread) => string;
  renderMenu?: (group: ProjectGroup, control: ProjectMenuControl) => ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAllThreads, setShowAllThreads] = useState(false);
  const Icon = expanded ? RiFolderOpenLine : RiFolderLine;
  const menu = renderMenu?.(group, { isOpen: menuOpen, setOpen: setMenuOpen });
  const visibleThreads = showAllThreads
    ? group.threads
    : group.threads.slice(0, VISIBLE_THREADS_PER_PROJECT);
  const hiddenThreadCount = group.threads.length - visibleThreads.length;

  return (
    <div className="group/proj relative flex w-full flex-col">
      <div className="flex w-full items-center">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => onToggle(group.key)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-2lg p-2 transition-colors duration-150 ease hover:bg-background-secondary-hover"
        >
          <Icon className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left text-body-medium whitespace-nowrap text-text-secondary">
            {group.label}
          </span>
        </button>
        {menu}
      </div>
      <div
        aria-hidden={!expanded}
        className={cx(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-in-out",
          expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          {group.threads.length > 0 ? (
            <>
              <ul
                aria-label={`Threads in ${group.label}`}
                className="relative flex w-full flex-col gap-0.5 pt-0.5"
              >
                <TreeConnector count={visibleThreads.length} />
                {visibleThreads.map((thread) => (
                  <li key={thread.id}>
                    <ThreadItem
                      thread={thread}
                      href={threadHref(thread)}
                      active={Boolean(thread.isSelected)}
                      tabIndex={expanded ? undefined : -1}
                    />
                  </li>
                ))}
              </ul>
              {hiddenThreadCount > 0 || showAllThreads ? (
                <button
                  type="button"
                  tabIndex={expanded ? undefined : -1}
                  onClick={() => setShowAllThreads((value) => !value)}
                  className="ml-7 rounded-lg px-2 py-1 text-caption-1-regular text-text-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-secondary"
                >
                  {showAllThreads ? "Show fewer" : `Show ${hiddenThreadCount} more`}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The project -> thread tree: a folder per project, its threads nested beneath
 * the curved connector when expanded. Expansion is controlled (so the shell can
 * persist it), threads navigate via `threadHref`, and each folder can carry a
 * per-project menu via `renderMenu`.
 */
export function ProjectThreadTree({
  groups,
  isExpanded,
  onToggle,
  threadHref,
  renderMenu,
}: {
  groups: readonly ProjectGroup[];
  isExpanded: (key: string) => boolean;
  onToggle: (key: string) => void;
  threadHref: (thread: ProjectThread) => string;
  renderMenu?: (group: ProjectGroup, control: ProjectMenuControl) => ReactNode;
}) {
  return (
    <nav aria-label="Projects" className="flex w-full flex-col gap-1">
      {groups.map((group) => (
        <ProjectFolder
          key={group.key}
          group={group}
          expanded={isExpanded(group.key)}
          onToggle={onToggle}
          threadHref={threadHref}
          renderMenu={renderMenu}
        />
      ))}
    </nav>
  );
}
