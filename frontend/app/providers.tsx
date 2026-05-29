'use client';

import { ThemeProvider } from 'next-themes';
import { TooltipProvider } from '@radix-ui/react-tooltip';

import { SubagentPane } from '@/components/chat/subagent-pane';

/**
 * Client-side provider stack. Kept as a leaf so the root layout stays a
 * server component. `next-themes` drives the theme class (`dark` / `aura` /
 * `harbor` / `light`) on <html>; the
 * Radix TooltipProvider is hoisted here so any vendored AlignUI tooltip works
 * out of the box anywhere in the tree.
 *
 * `SubagentPane` is the single global instance of the subagent viewing pane —
 * a portal-based slide-over any surface can open via `openSubagentPane(runId)`.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute='class'
      defaultTheme='light'
      enableSystem={false}
      themes={['light', 'dark', 'aura', 'harbor']}
    >
      <TooltipProvider delayDuration={100} skipDelayDuration={300} disableHoverableContent>
        {children}
        <SubagentPane />
      </TooltipProvider>
    </ThemeProvider>
  );
}
