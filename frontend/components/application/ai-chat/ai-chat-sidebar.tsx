"use client";

import type { ComponentType } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  RiAddFill,
  RiCustomerServiceLine,
  RiFolderLine,
  RiFolderOpenLine,
  RiGuideLine,
  RiRobot2Line,
  RiSearchLine,
  RiSettings4Line,
  RiSideBarFill,
} from "@remixicon/react";
import { DashboardUserMenu } from "@/components/application/dashboard/dashboard-user-menu";
import { SettingsModal } from "@/components/application/settings/settings-modal";
import { ThemeToggle } from "@/components/application/theme/theme-toggle";
import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { CloseButton } from "@/components/base/buttons/close-button";
import { Kbd } from "@/components/base/kbd/kbd";
import { cx } from "@/utils/cx";

/**
 * Figma source: Board UI → "ai_chat" → Sidebar (node 4030:5910, 260×876).
 *
 * The AI-chat variant of the floating sidebar — same 260px panel (p 12,
 * radius/3xl, white 1px border, sidebar-elevation shadow, bg
 * background/secondary) but with a chat-first nav: primary actions
 * (New agent / Automations / Customize), a "Repositories" tree whose repos
 * expand into recent chats (36px-indented rows with relative-time chips and
 * a curved tree connector), and a footer that swaps the dashboard's team
 * menu for a "Board team · Pro Plan" card with an Upgrade button.
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export interface AiChatThread {
  id?: string;
  label: string;
  /** Relative-time chip (e.g. "34m"). */
  time: string;
  isSelected?: boolean;
}

export interface AiChatRepo {
  label: string;
  /** Recent chats listed when the repo is expanded. */
  threads: AiChatThread[];
  /** Expanded on first render (folder-open icon + visible threads). */
  defaultOpen?: boolean;
}

const DEFAULT_REPOS: AiChatRepo[] = [
  {
    label: "boardui",
    threads: [
      { label: "pro badge restyle", time: "2h" },
      { label: "installation docs page", time: "1d" },
    ],
  },
  {
    label: "vibl coding project",
    defaultOpen: true,
    threads: [
      { id: "landing-page-design", label: "landing page design", time: "34m" },
      { id: "image-generation", label: "image generation", time: "now" },
      { id: "coding-scenario", label: "coding scenario", time: "now" },
      { label: "mobile app for vuejs...", time: "5h" },
      { label: "code refactor dropdo...", time: "18h" },
    ],
  },
  {
    label: "strider landing page work",
    threads: [
      { label: "hero section animation", time: "3d" },
      { label: "pricing table copy", time: "4d" },
    ],
  },
  {
    label: "pirate mini game iOS",
    threads: [
      { label: "cannon physics tuning", time: "1w" },
      { label: "sprite sheet cleanup", time: "2w" },
    ],
  },
];

/** Top-level nav row — icon + label, p 8, radius/2lg (same recipe as the
 *  dashboard sidebar's unselected items). */
function NavItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: IconComponent;
  label: string;
  /** Action rows (e.g. Settings → modal) intercept the navigation. */
  onClick?: () => void;
}) {
  return (
    <a
      href="#"
      aria-label={label}
      onClick={
        onClick
          ? (event) => {
              event.preventDefault();
              onClick();
            }
          : undefined
      }
      className="flex w-full items-center gap-2 rounded-2lg p-2 transition-colors duration-150 ease hover:bg-background-secondary-hover"
    >
      <Icon className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
      <span className="text-body-medium whitespace-nowrap text-text-secondary">{label}</span>
    </a>
  );
}

/** Chat row under an open repo — indented 36px (pl aligns with the repo
 *  label), py 5, with a relative-time chip on the right. */
function ThreadItem({
  id,
  label,
  time,
  isSelected = false,
  tabIndex,
  onSelect,
}: AiChatThread & { tabIndex?: number; onSelect?: (id: string) => void }) {
  return (
    <a
      href="#"
      tabIndex={tabIndex}
      aria-current={isSelected ? "page" : undefined}
      onClick={(event) => {
        event.preventDefault();
        if (id) onSelect?.(id);
      }}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-2lg py-[5px] pr-2 pl-9 transition-colors duration-150 ease",
        isSelected ? "bg-background-secondary-hover" : "hover:bg-background-secondary-hover",
      )}
    >
      <span className="min-w-0 flex-1 truncate text-body-medium text-text-secondary">{label}</span>
      <span className="inline-flex shrink-0 items-center justify-center rounded-sm bg-background-tertiary-default px-1 py-px text-caption-1-medium whitespace-nowrap text-text-secondary">
        {time}
      </span>
    </a>
  );
}

/**
 * Curved tree connector (Figma "Vector 132"): a vertical guide dropping from
 * the repo's folder icon with a rounded elbow into each thread row. Rows are
 * 30px tall with 2px gaps; the trunk sits at the icon's center (x 17.5 within
 * the list) and each elbow lands 8px to the right at the row's center.
 */
function TreeConnector({ count }: { count: number }) {
  const rowPitch = 32; // 30px row + 2px gap
  const firstCenter = 15;
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

/** Expandable repo folder: clicking the row toggles its recent chats
 *  (folder → folder-open, threads slide in below with the tree connector).
 *  Expansion animates via the grid-rows 0fr→1fr trick so the list height
 *  eases smoothly without measuring content. */
function RepoItem({
  repo,
  forceOpen = false,
  activeThreadId,
  onThreadSelect,
}: {
  repo: AiChatRepo;
  forceOpen?: boolean;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
}) {
  const [open, setOpen] = useState(repo.defaultOpen ?? false);
  const expanded = forceOpen || open;
  const Icon = expanded ? RiFolderOpenLine : RiFolderLine;

  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 transition-colors duration-150 ease hover:bg-background-secondary-hover"
      >
        <Icon className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
        <span className="truncate text-body-medium whitespace-nowrap text-text-secondary">
          {repo.label}
        </span>
      </button>
      <div
        aria-hidden={!expanded}
        className={cx(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-in-out",
          expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="relative flex w-full flex-col gap-0.5 pt-0.5">
            <TreeConnector count={repo.threads.length} />
            {repo.threads.map((thread) => (
              <ThreadItem
                key={thread.label}
                {...thread}
                isSelected={thread.id ? thread.id === activeThreadId : thread.isSelected}
                onSelect={onThreadSelect}
                tabIndex={expanded ? undefined : -1}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AiChatSidebar({
  repos = DEFAULT_REPOS,
  className,
  activeThreadId,
  onThreadSelect,
  onClose,
  flat = false,
}: {
  repos?: AiChatRepo[];
  className?: string;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onClose?: () => void;
  flat?: boolean;
} = {}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [query, setQuery] = useState("");
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const searchFieldRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (label: string) => label.toLocaleLowerCase().includes(normalizedQuery);
  const primaryActions = [
    { icon: RiAddFill, label: "New agent" },
    { icon: RiRobot2Line, label: "Automations" },
    { icon: RiGuideLine, label: "Customize" },
  ].filter((item) => matches(item.label));
  const filteredRepos = repos.flatMap((repo) => {
    if (!normalizedQuery || repo.label.toLocaleLowerCase().includes(normalizedQuery)) {
      return [repo];
    }
    const threads = repo.threads.filter((thread) =>
      thread.label.toLocaleLowerCase().includes(normalizedQuery),
    );
    return threads.length ? [{ ...repo, threads }] : [];
  });
  const hasAnyMatch =
    primaryActions.length > 0 ||
    filteredRepos.length > 0 ||
    matches("Support") ||
    matches("Settings");

  const activateSearch = useCallback(() => setSearchActive(true), []);
  const deactivateSearch = useCallback((restoreFocus: boolean) => {
    setQuery("");
    setSearchActive(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => searchTriggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!searchActive) return;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [searchActive]);

  useEffect(() => {
    if (!searchActive) return;

    const onOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && searchFieldRef.current?.contains(target)) return;
      deactivateSearch(false);
    };

    document.addEventListener("click", onOutsideClick);
    return () => document.removeEventListener("click", onOutsideClick);
  }, [deactivateSearch, searchActive]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() === "l" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        activateSearch();
      }
    };

    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [activateSearch]);

  return (
    <aside
      className={cx(
        "flex h-full w-[260px] shrink-0 flex-col justify-between overflow-hidden p-3",
        flat
          ? "bg-background-full"
          : "rounded-3xl border border-border-button-white bg-background-secondary-default shadow-sidebar",
        className,
      )}
    >
      <div className="flex min-h-0 w-full flex-col gap-3">
        {/* Workspace switcher + panel toggle */}
        <div className="flex w-full flex-row items-center justify-between">
          <DashboardUserMenu
            avatarClassName={
              flat ? "bg-background-tertiary-default dark:bg-background-secondary-default" : undefined
            }
          />
          {flat ? (
            <button
              type="button"
              aria-label="Search"
              className="flex size-9 cursor-pointer items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary transition-colors duration-150 hover:bg-background-tertiary-hover/55"
            >
              <RiSearchLine className="size-5" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Collapse sidebar"
              onClick={onClose}
              className="cursor-pointer text-foreground-icon-secondary"
            >
              <RiSideBarFill className="size-5 -scale-x-100" aria-hidden />
            </button>
          )}
        </div>

        {/* Quick search */}
        {!flat && (searchActive ? (
          <div
            ref={searchFieldRef}
            className="flex w-full items-center gap-2 rounded-full bg-background-tertiary-default py-2 pr-2.5 pl-2 ring-2 ring-inset ring-border-button-active transition-[background-color,box-shadow] duration-[var(--input-transition-ms)] ease"
          >
            <RiSearchLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
            <input
              ref={searchInputRef}
              type="search"
              aria-label="Filter template navigation"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  deactivateSearch(true);
                }
              }}
              placeholder="Search navigation…"
              className="min-w-0 flex-1 bg-transparent text-body-medium text-text-primary outline-none placeholder:text-text-tertiary"
            />
            <CloseButton
              size="2xs"
              aria-label="Clear navigation search"
              onClick={() => deactivateSearch(true)}
              className="bg-background-tertiary-hover"
            />
          </div>
        ) : (
          <button
            ref={searchTriggerRef}
            type="button"
            aria-label="Quick Search"
            onClick={activateSearch}
            className="flex w-full cursor-pointer items-center gap-2 rounded-full bg-background-tertiary-default p-2 transition-colors duration-150 hover:bg-background-tertiary-hover/55"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <RiSearchLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
              <span className="text-body-medium whitespace-nowrap text-text-secondary">
                Quick Search
              </span>
            </span>
            <Kbd>⌘L</Kbd>
          </button>
        ))}

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto [scrollbar-width:none]">
          {/* Primary actions */}
          <nav className="flex w-full shrink-0 flex-col gap-1">
            {primaryActions.map((item) => (
              <NavItem key={item.label} {...item} />
            ))}
          </nav>

          {/* Repositories tree */}
          {filteredRepos.length > 0 && (
            <div className="flex w-full flex-col gap-2.5">
              <span className="text-body-medium text-text-secondary">Repositories</span>
              <nav className="flex w-full flex-col gap-1">
                {filteredRepos.map((repo) => (
                  <RepoItem
                    key={repo.label}
                    repo={repo}
                    forceOpen={Boolean(normalizedQuery)}
                    activeThreadId={activeThreadId}
                    onThreadSelect={onThreadSelect}
                  />
                ))}
              </nav>
            </div>
          )}
          {!hasAnyMatch && (
            <p className="px-2 text-body-regular text-text-tertiary">No results</p>
          )}
        </div>
      </div>

      <div className="flex w-full flex-col gap-3 pt-3">
        <ThemeToggle
          appearance="sidebar-segmented"
          className={flat ? "!bg-background-secondary-default" : undefined}
        />
        {/* Secondary nav */}
        <nav className="flex w-full flex-col gap-1">
          {matches("Support") && <NavItem icon={RiCustomerServiceLine} label="Support" />}
          {matches("Settings") && (
            <NavItem
              icon={RiSettings4Line}
              label="Settings"
              onClick={() => setSettingsOpen(true)}
            />
          )}
        </nav>

        {/* Plan card */}
        <div
          className={cx(
            "flex w-full items-center justify-between rounded-xl py-2 pr-3 pl-2.5",
            flat ? "bg-background-secondary-default" : "bg-background-tertiary-default",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Avatar
              size="md"
              color="blue"
              initials="B"
              className="text-[18.824px] leading-[22.588px] font-medium"
            />
            <span className="flex min-w-0 flex-col items-start justify-center">
              <span className="text-body-medium whitespace-nowrap text-text-primary">Board team</span>
              <span className="text-body-regular whitespace-nowrap text-text-secondary">
                Pro Plan
              </span>
            </span>
          </span>
          <Button variant="secondary" size="small">
            Upgrade
          </Button>
        </div>
      </div>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        planArtSrc="/templates/settings-plan-art.png"
      />
    </aside>
  );
}
