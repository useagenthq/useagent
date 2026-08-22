'use client';

import { RiContrast2Line } from '@remixicon/react';

import { ThemeMenu } from './theme-menu';

/**
 * Theme picker trigger for the app-shell clusters (thread sidebar footer,
 * compact rail, library sidebar). A compact icon button on BoardUI tokens that
 * opens the Light / Midnight / Aura / Harbor menu. The BoardUI application
 * theme-toggle block is light/dark-only and owns its own storage, so the
 * four-theme next-themes menu stays; theming flips via the theme class on
 * <html> (next-themes), so components stay on semantic tokens with no `dark:`
 * prefixes.
 */
export function ThemeToggle() {
  return (
    <ThemeMenu
      triggerAriaLabel='Change theme'
      triggerClassName='flex size-9 shrink-0 items-center justify-center rounded-2lg text-foreground-icon-secondary transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary'
    >
      <RiContrast2Line className='size-5' aria-hidden />
    </ThemeMenu>
  );
}
