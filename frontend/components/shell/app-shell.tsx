"use client";

import { RiSidebarFoldLine, RiSidebarUnfoldLine } from "@remixicon/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/utils/cn";
import { useWorkingSignal } from "./working-signal";

export interface AppShellProps {
  sidebar: ReactNode;
  children: ReactNode;
}

/**
 * Full-bleed application frame shared by threads and Library pages. The global
 * header and selected sidebar stay fixed while the page owns the scrollable
 * workspace. Content may use cards, but the product itself is never wrapped in
 * a decorative floating card.
 *
 * `<main>` is a bounded scroll container (`flex-1 min-h-0 overflow-y-auto`), so
 * page content flows and scrolls, while a full-height child (e.g. the session
 * split view `editor | terminal`) can fill it with `h-full`. The halftone sits
 * on its own `-z-10` layer (main is `isolate`) so it never masks page content.
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

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  return (
    <div className="relative flex h-dvh w-full overflow-hidden bg-bg-white-0">
      <div
        ref={sidebarContainerRef}
        aria-hidden={sidebarCollapsed}
        inert={sidebarCollapsed}
        className={cn(
          "hidden h-full shrink-0 overflow-hidden transition-[width] duration-200 md:block",
          sidebarCollapsed ? "pointer-events-none w-0" : "w-64",
        )}
        data-testid="primary-sidebar-shell"
      >
        {sidebar}
      </div>
      <button
        ref={sidebarRestoreRef}
        type="button"
        onClick={() => {
          if (sidebarCollapsed) setSidebarCollapsed(false);
          else collapseSidebar();
        }}
        aria-label={sidebarCollapsed ? "Open navigation" : "Collapse navigation"}
        aria-pressed={sidebarCollapsed}
        className={cn(
          "absolute top-3 z-40 hidden size-8 items-center justify-center rounded-lg text-text-soft-400 outline-none transition-[left,background-color,color] hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 md:flex",
          sidebarCollapsed ? "left-3" : "left-[13.5rem]",
        )}
      >
        {sidebarCollapsed ? (
          <RiSidebarUnfoldLine className="size-4" aria-hidden />
        ) : (
          <RiSidebarFoldLine className="size-4" aria-hidden />
        )}
      </button>
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
        className="absolute left-3 top-3 z-40 flex size-8 items-center justify-center rounded-lg text-text-soft-400 outline-none hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 md:hidden"
      >
        <RiSidebarUnfoldLine className="size-4" aria-hidden />
      </button>
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-overlay backdrop-blur-sm"
          />
          <div className="relative h-full w-64">{sidebar}</div>
        </div>
      ) : null}
      <main className="relative isolate min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg-white-0">
        <div
          aria-hidden
          className="bg-halftone pointer-events-none absolute inset-x-0 top-0 -z-10 h-40"
        />
        {children}
      </main>
    </div>
  );
}
