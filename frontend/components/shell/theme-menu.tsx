'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { RiCheckLine } from '@remixicon/react';

import * as Dropdown from '@/components/ui/dropdown';
import { cn } from '@/utils/cn';

/**
 * Theme options shown in the picker. UI copy is intentional: our default
 * Tokyo Night dark ramp reads as "Midnight" and the violet dark ramp as
 * "Aura" - the token classes on <html> stay `dark` / `aura` (see globals.css).
 * `swatch` is a fixed per-theme preview class defined in globals.css.
 */
export const THEME_OPTIONS = [
  { value: 'light', label: 'Light', swatch: 'theme-swatch-light' },
  { value: 'dark', label: 'Midnight', swatch: 'theme-swatch-dark' },
  { value: 'aura', label: 'Aura', swatch: 'theme-swatch-aura' },
] as const;

export type ThemeValue = (typeof THEME_OPTIONS)[number]['value'];

/** A small round two-tone (canvas + accent) dot previewing a theme. */
export function ThemeSwatch({ swatch, className }: { swatch: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'theme-swatch size-3.5 shrink-0 rounded-full ring-1 ring-inset ring-stroke-soft-200',
        swatch,
        className,
      )}
    />
  );
}

/**
 * Theme picker menu (Light / Midnight / Aura) built on the vendored Dropdown.
 * The caller supplies the trigger via `children` so it can be a compact icon
 * button in the app shell or a labeled control in Settings. Selection persists
 * through next-themes (localStorage); the active row is only marked once
 * mounted to avoid a hydration mismatch against the server-rendered theme.
 */
export function ThemeMenu({
  children,
  align = 'end',
  side,
}: {
  children: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
      <Dropdown.Content align={align} side={side} className='w-44'>
        <Dropdown.Label>Theme</Dropdown.Label>
        {THEME_OPTIONS.map((opt) => (
          <Dropdown.Item key={opt.value} onSelect={() => setTheme(opt.value)}>
            <ThemeSwatch swatch={opt.swatch} />
            <span className='flex-1'>{opt.label}</span>
            {mounted && theme === opt.value && <Dropdown.ItemIcon as={RiCheckLine} />}
          </Dropdown.Item>
        ))}
      </Dropdown.Content>
    </Dropdown.Root>
  );
}
