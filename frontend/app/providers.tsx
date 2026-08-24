'use client';

import { ThemeProvider } from 'next-themes';

import { SubagentPane } from '@/components/chat/subagent-pane';

/**
 * Client-side provider stack. Kept as a leaf so the root layout stays a
 * server component. `next-themes` drives the theme class (`dark` / `aura` /
 * `harbor` / `phosphor` / `slate` / `sakura-night` / `light` / `sakura` /
 * `phosphor-light`) on <html>.
 *
 * `SubagentPane` is the single global instance of the subagent viewing pane -
 * a portal-based slide-over any surface can open via `openSubagentPane(runId)`.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute='class'
      defaultTheme='dark'
      enableSystem={false}
      themes={[
        'light',
        'dark',
        'aura',
        'harbor',
        'phosphor',
        'phosphor-light',
        'sakura',
        'sakura-night',
        'slate',
      ]}
    >
      {children}
      <SubagentPane />
    </ThemeProvider>
  );
}
