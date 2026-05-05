'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { RiMoonLine, RiSunLine } from '@remixicon/react';

/**
 * Light/dark toggle for the top-nav right cluster. Guards against hydration
 * mismatch by only reflecting the resolved theme after mount. Theming flips via
 * the `.dark` class (next-themes) — components use semantic tokens, so both
 * themes render correctly with no `dark:` prefixes.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <button
      type='button'
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Light mode' : 'Dark mode'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className='flex size-9 shrink-0 items-center justify-center rounded-lg text-text-sub-600 outline-none transition-colors hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950'
    >
      {isDark ? (
        <RiSunLine className='size-5' aria-hidden />
      ) : (
        <RiMoonLine className='size-5' aria-hidden />
      )}
    </button>
  );
}
