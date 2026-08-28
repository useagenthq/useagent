"use client";

import { RiSidebarFoldLine, RiSidebarUnfoldLine } from "@remixicon/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useIsTabletBand } from "@/hooks/use-is-mobile";
import { cx } from "@/utils/cx";
import { AuroraBackdrop } from "./aurora-backdrop";
import { CompactSidebarRail } from "./compact-sidebar-rail";
import { useWorkingSignal } from "./working-signal";

export interface AppShellProps {
  sidebar: ReactNode;
  children: ReactNode;
}

/**
 * Full-bleed application frame shared by threads and Library pages. The global
 * header and selected sidebar stay fixed while the page owns the scrollable
 * workspace. The sidebar renders as a BoardUI floating panel inset from the
 * viewport edge (see sidebar-nav.tsx); the frame itself is never wrapped in a
 * decorative floating card.
 *
 * `<main>` is a bounded scroll container (`flex-1 min-h-0 overflow-y-auto`), so
 * page content flows and scrolls, while a full-height child (e.g. the session
 * split view `editor | terminal`) can fill it with `h-full`. The halftone sits
 * on its own `-z-10` layer (main is `isolate`) so it never masks page content.
 *
 * Below md the open-nav trigger lives in an IN-FLOW header row above `<main>`
 * (never a floating overlay), so no page header can render underneath it.
 */
export function AppShell({ sidebar, children }: AppShellProps) {
  const working = useWorkingSignal();
  const previousWorking = useRef(working);
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const sidebarRestoreRef = useRef<HTMLButtonElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const collapseSidebar = useCallback(() => {
    const focusWasInside = sidebarContainerRef.current?.contains(document.activeElement) ?? false;
    setSidebarCollapsed(true);
    if (focusWasInside) requestAnimationFrame(() => sidebarRestoreRef.current?.focus());
  }, []);

  useEffect(() => {
    if (working && !previousWorking.current) collapseSidebar();
    previousWorking.current = working;
  }, [collapseSidebar, working]);

  // Tablet band (md..<xl): not enough width for the full sidebar beside the
  // session split, so ENTERING the band folds the sidebar to the compact rail -
  // the same one-way fold the working signal performs; the user can still
  // expand it explicitly.
  const tabletBand = useIsTabletBand();
  const previousBand = useRef(false);
  useEffect(() => {
    if (tabletBand && !previousBand.current) collapseSidebar();
    previousBand.current = tabletBand;
  }, [collapseSidebar, tabletBand]);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  return (
    <div
      className="group/shell relative flex h-dvh w-full overflow-hidden bg-background-full"
      data-sidebar-collapsed={sidebarCollapsed ? "" : undefined}
    >
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
          onClick={collapseSidebar}
          aria-label="Collapse navigation"
          className="absolute left-[12.5rem] top-6 z-40 hidden size-8 items-center justify-center rounded-2lg text-foreground-icon-secondary outline-none transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring md:flex"
        >
          <RiSidebarFoldLine className="size-4" aria-hidden />
        </button>
      )}
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          />
          <div className="relative h-full w-64">{sidebar}</div>
        </div>
      ) : null}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center px-2 md:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="flex size-8 items-center justify-center rounded-2lg text-foreground-icon-secondary outline-none hover:bg-background-primary-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            <RiSidebarUnfoldLine className="size-4" aria-hidden />
          </button>
        </div>
        <main className="relative isolate min-h-0 min-w-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
