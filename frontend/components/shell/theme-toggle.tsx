'use client';

import { RiContrast2Line } from '@remixicon/react';

import { ThemeMenu } from './theme-menu';

/**
 * Theme picker trigger for the app-shell clusters (thread sidebar footer,
 * compact rail, library sidebar). A compact icon button that opens the
 * Light / Midnight / Aura menu. Theming flips via the theme class on <html>
 * (next-themes), so components stay on semantic tokens with no `dark:` prefixes.
 */
export function ThemeToggle() {
  return (
    <ThemeMenu align='end'>
      <button
        type='button'
        aria-label='Change theme'
        title='Change theme'
        className='flex size-9 shrink-0 items-center justify-center rounded-lg text-text-sub-600 outline-none transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950'
      >
        <RiContrast2Line className='size-5' aria-hidden />
      </button>
    </ThemeMenu>
  );
}
