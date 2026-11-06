"use client";

// Tree treatment adapted from the Board UI Figma "ai_chat" sidebar:
// the Repositories tree whose folders expand into recent chats as plainly
// indented rows (folder->folder-open parents, doc-icon children, no connector
// lines), with a grid-rows 0fr->1fr height animation and right-aligned muted
// relative times. Only the tree section is vendored - our shell keeps its own
// nav, brand, search and account chrome.

import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiFileTextLine,
  RiFolderLine,
  RiFolderOpenLine,
  RiPushpinLine,
} from "@remixicon/react";
import type { RunConnector, RunStatus } from "@useagent/agent-client/wire";
import type { ProductThreadStatus } from "@useagent/agent-client";
import Link from "next/link";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type NativeAgentRow, NativeAgentRows } from "@/components/session-ui/native-agent-rows";
import { OriginLink } from "@/components/session-ui/origin-link";
import { StatusDot } from "@/components/shared/status-dot";
import { THREAD_DRAG_TYPE } from "@/components/shell/sidebar-bookmarks-store";
import { threadStatusPresentation } from "@/components/shell/thread-discovery";
import { cx } from "@/utils/cx";

const VISIBLE_THREADS_PER_PROJECT = 6;

/** A single thread row under a project folder. `time` is the pre-formatted
 *  relative-time chip (e.g. "34m ago"); `id` addresses the thread. */
export interface ProjectThread {
  id: string;
  label: string;
  time: string;
  status: RunStatus | ProductThreadStatus;
  isSelected?: boolean;
  engine?: string;
  model?: string;
  /** The connector the thread arrived through, when it was not started here. */
  origin?: RunConnector | null;
  children?: ProjectThread[];
  nativeChildren?: { rows: readonly NativeAgentRow[]; overflow: number } | null;
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

/** Thread row under an open folder - one indent step past the folder icon, a
 *  doc icon in the shared 16px icon column (a lime check once the thread
 *  completed), the same uniform 32px row height as every other rail row, and a
 *  plain right-aligned muted relative time. Navigates to the thread; the active
 *  thread holds a rounded pill fill. The row can be dragged onto the rail's
 *  Bookmarks, and carries a pin button for the same on hover or focus. */
function ThreadItem({
  thread,
  href,
  active,
  hasChildren,
  expanded,
  onToggle,
  onPin,
}: {
  thread: ProjectThread;
  href: string;
  active: boolean;
  hasChildren: boolean;
  expanded: boolean;
  onToggle: () => void;
  onPin?: () => void;
}) {
  const status = threadStatusPresentation(thread.status);

  return (
    <div
      data-session-ui="thread-row"
      draggable
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        event.dataTransfer.setData(THREAD_DRAG_TYPE, thread.id);
        event.dataTransfer.effectAllowed = "copy";
      }}
      className={cx(
        "group flex h-8 w-full items-center gap-2 rounded-2lg pr-2 pl-6 transition-colors duration-150 ease",
        active
          ? "bg-background-secondary-hover text-text-primary"
          : "hover:bg-background-secondary-hover",
      )}
    >
      <span className="flex w-4 shrink-0 items-center justify-center">
        {hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${thread.label}`}
            onClick={onToggle}
            className="flex size-6 -mx-1 items-center justify-center rounded-sm"
          >
            {expanded
              ? <RiArrowDownSLine className="size-4" aria-hidden />
              : <RiArrowRightSLine className="size-4" aria-hidden />}
          </button>
        ) : status.dot ? (
          <span role="img" aria-label={status.label} title={status.label}>
            <StatusDot {...status.dot} />
          </span>
        ) : thread.status === "completed" ? (
          <span role="img" aria-label="Completed" title="Completed">
            <RiCheckLine className="size-4 text-lime-600" aria-hidden />
          </span>
        ) : (
          <RiFileTextLine className="size-4 text-foreground-icon-tertiary" aria-hidden />
        )}
      </span>
      <Link
        href={href}
        tabIndex={-1}
        aria-current={active ? "page" : undefined}
        title={thread.label}
        className={cx(
          "min-w-0 flex-1 truncate text-body-2-medium",
          active ? "text-text-primary" : "text-text-secondary",
        )}
      >
        {thread.label}
      </Link>
      <OriginLink connector={thread.origin} compact />
      <span className="shrink-0 text-caption-1-medium whitespace-nowrap tabular-nums text-text-tertiary">
        {thread.time}
      </span>
      {onPin && (
        <button
          type="button"
          aria-label={`Pin ${thread.label}`}
          title="Pin to Bookmarks"
          onClick={onPin}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-text-tertiary opacity-0 transition-opacity hover:bg-background-tertiary-hover hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring group-hover:opacity-100"
        >
          <RiPushpinLine className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

function ThreadBranch({
  thread,
  threadHref,
  level = 1,
  parentId = null,
  position,
  setSize,
  collapsed,
  activeId,
  onActive,
  onKeyDown,
  onToggle,
  enabled,
  onPin,
}: {
  thread: ProjectThread;
  threadHref: (thread: ProjectThread) => string;
  level?: number;
  parentId?: string | null;
  position: number;
  setSize: number;
  collapsed: ReadonlySet<string>;
  activeId: string | null;
  onActive: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onToggle: (id: string) => void;
  enabled: boolean;
  onPin?: (id: string) => void;
}) {
  const hasChildren = Boolean(
    thread.children?.length || thread.nativeChildren?.rows.length,
  );
  const expanded = hasChildren && !collapsed.has(thread.id);
  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-posinset={position}
      aria-setsize={setSize}
      aria-expanded={hasChildren ? expanded : undefined}
      tabIndex={enabled && activeId === thread.id ? 0 : -1}
      data-thread-tree-id={thread.id}
      data-parent-thread-id={parentId ?? undefined}
      onFocus={() => onActive(thread.id)}
      onKeyDown={enabled ? onKeyDown : undefined}
      className="outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      <ThreadItem
        thread={thread}
        href={threadHref(thread)}
        active={Boolean(thread.isSelected)}
        hasChildren={hasChildren}
        expanded={expanded}
        onToggle={() => onToggle(thread.id)}
        onPin={onPin ? () => onPin(thread.id) : undefined}
      />
      {expanded ? (
        // WAI-ARIA tree children require a role=group container; fieldset would add unrelated form semantics.
        <div role="group" className="pl-4">
          {thread.nativeChildren ? (
            <NativeAgentRows
              rows={thread.nativeChildren.rows}
              overflow={thread.nativeChildren.overflow}
              tabIndex={enabled ? undefined : -1}
            />
          ) : null}
          {thread.children?.map((child, index, siblings) => (
            <ThreadBranch
              key={child.id}
              thread={child}
              threadHref={threadHref}
              level={level + 1}
              parentId={thread.id}
              position={index + 1}
              setSize={siblings.length}
              collapsed={collapsed}
              activeId={activeId}
              onActive={onActive}
              onKeyDown={onKeyDown}
              onToggle={onToggle}
              enabled={enabled}
              onPin={onPin}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProjectThreadList({
  threads,
  threadHref,
  ariaLabel,
  enabled = true,
  onPinThread,
}: {
  threads: readonly ProjectThread[];
  threadHref: (thread: ProjectThread) => string;
  ariaLabel: string;
  enabled?: boolean;
  /** Pins a thread to the rail's Bookmarks; rows get a pin button when given. */
  onPinThread?: (id: string) => void;
}) {
  const treeRef = useRef<HTMLDivElement>(null);
  const ids = useMemo(() => projectThreadTreeIds(threads), [threads]);
  const [activeId, setActiveId] = useState<string | null>(() =>
    threads.find((thread) => thread.isSelected)?.id ?? threads[0]?.id ?? null,
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setActiveId((current) => retainThreadTreeActiveId(current, ids));
  }, [ids]);
  const focusAt = (index: number) => {
    const rows = treeRef.current?.querySelectorAll<HTMLElement>("[data-thread-tree-id]");
    rows?.[Math.max(0, Math.min(index, (rows.length ?? 1) - 1))]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A row's own controls keep their native activation: Enter or Space on a
    // button (the pin) or on a focused inner link (the origin mark) must not
    // open the thread instead.
    if (
      event.target !== event.currentTarget &&
      ((event.target as HTMLElement).closest("button") || event.key === "Enter" || event.key === " ")
    ) {
      return;
    }
    const rows = [...(treeRef.current?.querySelectorAll<HTMLElement>("[data-thread-tree-id]") ?? [])];
    const index = rows.indexOf(event.currentTarget);
    const id = event.currentTarget.dataset.threadTreeId ?? "";
    if (event.key === "ArrowDown") focusAt(index + 1);
    else if (event.key === "ArrowUp") focusAt(index - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(rows.length - 1);
    else if (event.key === "ArrowRight" && event.currentTarget.getAttribute("aria-expanded") === "false") {
      setCollapsed((current) => { const next = new Set(current); next.delete(id); return next; });
    } else if (event.key === "ArrowRight" && event.currentTarget.getAttribute("aria-expanded") === "true") {
      focusAt(index + 1);
    } else if (event.key === "ArrowLeft") {
      if (event.currentTarget.getAttribute("aria-expanded") === "true") {
        setCollapsed((current) => new Set(current).add(id));
      } else {
        const parent = event.currentTarget.dataset.parentThreadId;
        treeRef.current?.querySelector<HTMLElement>(`[data-thread-tree-id="${CSS.escape(parent ?? "")}"]`)?.focus();
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.currentTarget.querySelector<HTMLAnchorElement>("a")?.click();
    } else return;
    event.preventDefault();
  };
  const onToggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <div ref={treeRef} role="tree" aria-label={ariaLabel} className="flex w-full flex-col">
      {threads.map((thread, index) => (
        <ThreadBranch
          key={thread.id}
          thread={thread}
          threadHref={threadHref}
          position={index + 1}
          setSize={threads.length}
          collapsed={collapsed}
          activeId={activeId}
          onActive={setActiveId}
          onKeyDown={onKeyDown}
          onToggle={onToggle}
          enabled={enabled}
          onPin={onPinThread}
        />
      ))}
    </div>
  );
}

export function projectThreadTreeIds(threads: readonly ProjectThread[]): string[] {
  const result: string[] = [];
  const visit = (nodes: readonly ProjectThread[]) => {
    for (const node of nodes) {
      result.push(node.id);
      visit(node.children ?? []);
    }
  };
  visit(threads);
  return result;
}

export function retainThreadTreeActiveId(
  activeId: string | null,
  ids: readonly string[],
): string | null {
  return activeId && ids.includes(activeId) ? activeId : ids[0] ?? null;
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
  onPinThread,
}: {
  group: ProjectGroup;
  expanded: boolean;
  onToggle: (key: string) => void;
  threadHref: (thread: ProjectThread) => string;
  renderMenu?: (group: ProjectGroup, control: ProjectMenuControl) => ReactNode;
  onPinThread?: (id: string) => void;
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
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-2lg px-2.5 py-1.5 transition-colors duration-150 ease hover:bg-background-secondary-hover"
        >
          <span className="flex w-4 shrink-0 items-center justify-center">
            <Icon className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-left text-body-2-medium whitespace-nowrap text-text-secondary">
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
              <ProjectThreadList
                threads={visibleThreads}
                threadHref={threadHref}
                ariaLabel={`Threads in ${group.label}`}
                enabled={expanded}
                onPinThread={onPinThread}
              />
              {hiddenThreadCount > 0 || showAllThreads ? (
                <button
                  type="button"
                  tabIndex={expanded ? undefined : -1}
                  onClick={() => setShowAllThreads((value) => !value)}
                  className="ml-6 rounded-lg px-2 py-1 text-caption-1-regular text-text-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-secondary"
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
 * as indented doc rows when expanded. Expansion is controlled (so the shell can
 * persist it), threads navigate via `threadHref`, and each folder can carry a
 * per-project menu via `renderMenu`.
 */
export function ProjectThreadTree({
  groups,
  isExpanded,
  onToggle,
  threadHref,
  renderMenu,
  onPinThread,
}: {
  groups: readonly ProjectGroup[];
  isExpanded: (key: string) => boolean;
  onToggle: (key: string) => void;
  threadHref: (thread: ProjectThread) => string;
  renderMenu?: (group: ProjectGroup, control: ProjectMenuControl) => ReactNode;
  /** Pins a thread to the rail's Bookmarks; rows get a pin button when given. */
  onPinThread?: (id: string) => void;
}) {
  return (
    <nav aria-label="Projects" className="flex w-full flex-col">
      {groups.map((group) => (
        <ProjectFolder
          key={group.key}
          group={group}
          expanded={isExpanded(group.key)}
          onToggle={onToggle}
          threadHref={threadHref}
          renderMenu={renderMenu}
          onPinThread={onPinThread}
        />
      ))}
    </nav>
  );
}
