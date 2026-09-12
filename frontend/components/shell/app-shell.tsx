"use client";

import { RiSidebarFoldLine, RiSidebarUnfoldLine } from "@remixicon/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useIsMobile, useIsTabletBand } from "@/hooks/use-is-mobile";
import { cx } from "@/utils/cx";
import { AuroraBackdrop } from "./aurora-backdrop";
import { CompactSidebarRail } from "./compact-sidebar-rail";
import { SidebarThreadsProvider } from "./sidebar-threads-provider";
import { useWorkingSignal } from "./working-signal";

export interface AppShellProps {
  sidebar: ReactNode;
  children: ReactNode;
  /** Session workspaces can opt into the compact tablet rail. Library and
   * settings pages keep their normal navigation unless they opt in too. */
  collapseSidebarAtTablet?: boolean;
}

/**
 * Full-bleed application frame shared by threads and Library pages. The global
 * header and selected sidebar stay fixed while the page owns the scrollable
 * workspace. The expanded sidebar is a flat edge-to-edge
 * column (see sidebar-nav.tsx); only the collapsed compact rail floats. The
 * frame itself is never wrapped in a decorative floating card.
 *
 * `<main>` is a bounded scroll container (`flex-1 min-h-0 overflow-y-auto`), so
 * page content flows and scrolls, while a full-height child (e.g. the session
 * split view `editor | terminal`) can fill it with `h-full`. The halftone sits
 * on its own `-z-10` layer (main is `isolate`) so it never masks page content.
 *
 * Below md the open-nav trigger lives in an IN-FLOW header row above `<main>`
 * (never a floating overlay), so no page header can render underneath it.
 */
export function AppShell({ sidebar, children, collapseSidebarAtTablet = false }: AppShellProps) {
  const working = useWorkingSignal();
  const previousWorking = useRef(working);
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const sidebarRestoreRef = useRef<HTMLButtonElement>(null);
  const mobileSidebarRef = useRef<HTMLDivElement>(null);
  const mobileOpenButtonRef = useRef<HTMLButtonElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // The collapse button sits outside the sidebar, so pressing it would drop
  // focus to <body>; it asks for the restore explicitly. Programmatic
  // collapses only move focus when it was about to vanish with the sidebar.
  const collapseSidebar = useCallback((restoreFocus = false) => {
    const focusWasInside = sidebarContainerRef.current?.contains(document.activeElement) ?? false;
    setSidebarCollapsed(true);
    if (restoreFocus || focusWasInside) requestAnimationFrame(() => sidebarRestoreRef.current?.focus());
  }, []);

  useEffect(() => {
    if (working && !previousWorking.current) collapseSidebar();
    previousWorking.current = working;
  }, [collapseSidebar, working]);

  // Session workspaces may opt into the tablet fold because they own a second
  // resizable rail. Ordinary AppShell consumers remain route-neutral.
  const tabletBand = useIsTabletBand();
  const previousBand = useRef(false);
  useEffect(() => {
    if (collapseSidebarAtTablet && tabletBand && !previousBand.current) collapseSidebar();
    previousBand.current = tabletBand;
  }, [collapseSidebar, collapseSidebarAtTablet, tabletBand]);

  // The drawer only exists below md; leaving the band (a rotation) must not
  // leave the page column inert behind a drawer that CSS no longer shows.
  const isMobile = useIsMobile();
  useEffect(() => {
    if (!isMobile) setMobileOpen(false);
  }, [isMobile]);

  // Modal drawer contract: focus enters the navigation on open, the page
  // column is inert behind the scrim, and focus returns to the trigger on close.
  useEffect(() => {
    if (!mobileOpen) return;
    mobileSidebarRef.current?.querySelector<HTMLElement>("a[href], button")?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      mobileOpenButtonRef.current?.focus();
    };
  }, [mobileOpen]);

  return (
    <SidebarThreadsProvider>
      <div
        className="group/shell relative flex h-dvh w-full overflow-hidden bg-background-full"
        data-sidebar-collapsed={sidebarCollapsed ? "" : undefined}
      >
        {/* First focusable element on every page: lets keyboard users jump
            past the navigation to the main landmark. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-background-primary-default focus:px-3 focus:py-1.5 focus:text-body-2-medium focus:text-text-primary focus:shadow-dropdown focus:outline-none focus:ring-2 focus:ring-border-focus-ring"
        >
          Skip to content
        </a>
        <AuroraBackdrop />
        <div
          ref={sidebarContainerRef}
          aria-hidden={sidebarCollapsed}
          inert={sidebarCollapsed}
          className={cx(
            "relative hidden h-full shrink-0 overflow-hidden transition-[width] duration-200 md:block",
            sidebarCollapsed ? "w-0" : "w-64",
          )}
          data-testid="primary-sidebar-shell"
        >
          {sidebar}
        </div>
        {sidebarCollapsed ? (
          <CompactSidebarRail
            expandButtonRef={sidebarRestoreRef}
            onExpand={() => setSidebarCollapsed(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => collapseSidebar(true)}
            aria-label="Collapse navigation"
            className="absolute left-[13.5rem] top-[8px] z-40 hidden size-8 items-center justify-center rounded-2lg text-foreground-icon-secondary outline-none transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring md:flex"
          >
            <RiSidebarFoldLine className="size-4" aria-hidden />
          </button>
        )}
        {mobileOpen ? (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="fixed inset-0 z-50 flex md:hidden"
          >
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            />
            <div ref={mobileSidebarRef} className="relative h-full w-64">
              {sidebar}
            </div>
          </div>
        ) : null}
        <div
          className="relative flex min-w-0 flex-1 flex-col"
          aria-hidden={mobileOpen}
          inert={mobileOpen}
        >
          <div className="flex h-12 shrink-0 items-center px-2 md:hidden">
            <button
              ref={mobileOpenButtonRef}
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
              className="flex size-8 items-center justify-center rounded-2lg text-foreground-icon-secondary outline-none hover:bg-background-primary-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiSidebarUnfoldLine className="size-4" aria-hidden />
            </button>
          </div>
          <main
            id="main-content"
            tabIndex={-1}
            className="relative isolate min-h-0 min-w-0 flex-1 overflow-y-auto outline-none"
          >
            {children}
          </main>
        </div>
      </div>
    </SidebarThreadsProvider>
  );
}
