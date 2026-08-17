import type { ReactNode } from "react";

import { TopNav } from "./top-nav";

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
  return (
    <div className="h-dvh w-full bg-bg-white-0">
      <div className="flex h-full w-full flex-col overflow-hidden">
        <TopNav />
        <div className="flex min-h-0 flex-1">
          {sidebar}
          <main className="relative isolate min-h-0 flex-1 overflow-y-auto bg-bg-white-0">
            <div
              aria-hidden
              className="bg-halftone pointer-events-none absolute inset-x-0 top-0 -z-10 h-40"
            />
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
