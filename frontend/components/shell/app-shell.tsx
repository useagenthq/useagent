import type { ReactNode } from 'react';

import { TopNav, type TopNavTab } from './top-nav';

export interface AppShellProps {
  activeTab: TopNavTab;
  /** Left rail — e.g. <AgentSidebar /> or <ChatSidebar />. */
  sidebar: ReactNode;
  children: ReactNode;
}

/**
 * The shared application frame: a rounded, bordered app card floating on the
 * recessed canvas (bg-weak-50), with the TopNav pinned on top, a sidebar on the
 * left, and a scrollable main region carrying a faint halftone field at its top
 * (matching the reference dark shell — boxed core + brand texture).
 *
 * `<main>` is a bounded scroll container (`flex-1 min-h-0 overflow-y-auto`), so
 * page content flows and scrolls, while a full-height child (e.g. the session
 * split view `editor | terminal`) can fill it with `h-full`. The halftone sits
 * on its own `-z-10` layer (main is `isolate`) so it never masks page content.
 */
export function AppShell({ activeTab, sidebar, children }: AppShellProps) {
  return (
    <div className='h-dvh w-full bg-bg-weak-50 p-2 sm:p-3'>
      <div className='flex h-full w-full flex-col overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-sm'>
        <TopNav activeTab={activeTab} />
        <div className='flex min-h-0 flex-1'>
          {sidebar}
          <main className='relative isolate min-h-0 flex-1 overflow-y-auto bg-bg-white-0'>
            <div
              aria-hidden
              className='bg-halftone pointer-events-none absolute inset-x-0 top-0 -z-10 h-40'
            />
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
