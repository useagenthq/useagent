"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/sidebar-kit/sidebar";
import { TooltipProvider } from "@/components/sidebar-kit/tooltip";
import { useIsTabletBand } from "@/hooks/use-is-mobile";
import { SidebarThreadsProvider } from "./sidebar-threads-provider";
import { useWorkingSignal } from "./working-signal";

export interface AppShellProps {
  sidebar: ReactNode;
  children: ReactNode;
  /** Session workspaces can opt into the compact tablet rail. */
  collapseSidebarAtTablet?: boolean;
  /** sidebar-trial: an optional second column (blocks.so "Double-Sided"),
   * rendered between the navigation rail and the page. */
  panel?: ReactNode;
}

/**
 * sidebar-trial: the application frame on the shadcn sidebar primitives
 * (blocks.so "Sidebar Dashboard Inset" pattern). The sidebar collapses to an
 * icon rail through SidebarTrigger; below md it becomes an off-canvas sheet.
 * The page column is the inset card; `<main>` stays the bounded scroll area.
 */
export function AppShell({
  sidebar,
  children,
  collapseSidebarAtTablet = false,
  panel,
}: AppShellProps) {
  return (
    <SidebarThreadsProvider>
      <TooltipProvider>
        <SidebarProvider
          className="h-dvh overflow-hidden bg-sidebar"
          style={{ "--sidebar-width": "17rem" } as React.CSSProperties}
        >
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-background-primary-default focus:px-3 focus:py-1.5 focus:text-body-2-medium focus:text-text-primary focus:shadow-dropdown focus:outline-none focus:ring-2 focus:ring-border-focus-ring"
          >
            Skip to content
          </a>
          <AutoCollapse collapseSidebarAtTablet={collapseSidebarAtTablet} />
          {sidebar}
          {panel}
          <SidebarInset className="relative min-h-0 min-w-0 overflow-hidden bg-background-full md:peer-data-[variant=inset]:mt-0 md:peer-data-[variant=inset]:rounded-t-none md:peer-data-[variant=inset]:shadow-md md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-0">
            <div className="flex h-12 shrink-0 items-center px-2 md:hidden">
              <SidebarTrigger aria-label="Open navigation" />
            </div>
            <main
              id="main-content"
              tabIndex={-1}
              className="relative isolate min-h-0 min-w-0 flex-1 overflow-y-auto outline-none"
            >
              {children}
            </main>
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </SidebarThreadsProvider>
  );
}

/** Keeps the old shell behavior: fold the rail when work starts, and on the
 * tablet band for session workspaces. */
function AutoCollapse({ collapseSidebarAtTablet }: { collapseSidebarAtTablet: boolean }) {
  const { setOpen } = useSidebar();
  const working = useWorkingSignal();
  const previousWorking = useRef(working);
  useEffect(() => {
    if (working && !previousWorking.current) setOpen(false);
    previousWorking.current = working;
  }, [setOpen, working]);

  const tabletBand = useIsTabletBand();
  const previousBand = useRef(false);
  useEffect(() => {
    if (collapseSidebarAtTablet && tabletBand && !previousBand.current) setOpen(false);
    previousBand.current = tabletBand;
  }, [collapseSidebarAtTablet, setOpen, tabletBand]);

  return null;
}
