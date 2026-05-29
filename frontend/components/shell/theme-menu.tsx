'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { RiCheckLine } from '@remixicon/react';

import {
  Dropdown,
  DropdownGroup,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
  type DropdownPopoverProps,
} from '@/components/base/dropdown/dropdown';
import { cx } from '@/utils/cx';

/**
 * Theme options shown in the picker. UI copy is intentional: our default
 * Tokyo Night dark ramp reads as "Midnight", the violet dark ramp as "Aura",
 * the deep blue-slate dark ramp as "Harbor", the CRT-green dark ramp as
 * "Phosphor", the cherry-blossom light ramp as "Sakura", and the blue-gray
 * dark ramp as "Slate" - the token classes on <html> stay `dark` / `aura` /
 * `harbor` / `phosphor` / `sakura` / `slate` (see globals.css). `swatch` is a
 * fixed per-theme preview class defined in globals.css.
 */
export const THEME_OPTIONS = [
  { value: 'light', label: 'Light', swatch: 'theme-swatch-light' },
  { value: 'dark', label: 'Midnight', swatch: 'theme-swatch-dark' },
  { value: 'aura', label: 'Aura', swatch: 'theme-swatch-aura' },
  { value: 'harbor', label: 'Harbor', swatch: 'theme-swatch-harbor' },
  { value: 'phosphor', label: 'Phosphor', swatch: 'theme-swatch-phosphor' },
  { value: 'sakura', label: 'Sakura', swatch: 'theme-swatch-sakura' },
  { value: 'slate', label: 'Slate', swatch: 'theme-swatch-slate' },
] as const;

export type ThemeValue = (typeof THEME_OPTIONS)[number]['value'];

/** A small round two-tone (canvas + accent) dot previewing a theme. */
export function ThemeSwatch({ swatch, className }: { swatch: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        'theme-swatch size-3.5 shrink-0 rounded-full ring-1 ring-inset ring-border-button-default',
        swatch,
        className,
      )}
    />
  );
}

/**
 * Theme picker menu (Light / Midnight / Aura / Harbor / Phosphor / Sakura /
 * Slate) on the BoardUI base Dropdown. The caller supplies the trigger CONTENT via `children` plus
 * `triggerClassName`/`triggerAriaLabel` (the trigger button itself is the
 * React Aria pressable, so callers must not nest their own <button>).
 * Selection persists through next-themes (localStorage); the active row is
 * only marked once mounted to avoid a hydration mismatch against the
 * server-rendered theme.
 */
export function ThemeMenu({
  children,
  triggerClassName,
  triggerAriaLabel = 'Change theme',
  placement = 'bottom end',
}: {
  children: React.ReactNode;
  triggerClassName?: string;
  triggerAriaLabel?: string;
  placement?: DropdownPopoverProps['placement'];
}) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  return (
    <Dropdown>
      <DropdownTrigger aria-label={triggerAriaLabel} className={triggerClassName}>
        {children}
      </DropdownTrigger>
      <DropdownPopover aria-label='Theme' placement={placement} className='w-44'>
        <DropdownGroup label='Theme'>
          {THEME_OPTIONS.map((opt) => (
            <DropdownItem
              key={opt.value}
              selected={mounted && theme === opt.value}
              onSelect={() => setTheme(opt.value)}
              className='px-2 py-1.5'
            >
              <ThemeSwatch swatch={opt.swatch} />
              <span className='flex-1 text-body-2-medium'>{opt.label}</span>
              {mounted && theme === opt.value && (
                <RiCheckLine className='size-4 shrink-0 text-foreground-icon-primary' aria-hidden />
              )}
            </DropdownItem>
          ))}
        </DropdownGroup>
      </DropdownPopover>
    </Dropdown>
  );
}
