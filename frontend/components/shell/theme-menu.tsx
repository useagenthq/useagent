'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { RiCheckLine } from '@remixicon/react';

import {
  Dropdown,
  DropdownMenu,
  DropdownMenuItem,
  DropdownTrigger,
  type DropdownPopoverProps,
} from '@/components/base/dropdown/dropdown';
import { cx } from '@/utils/cx';

/**
 * Theme options shown in the picker. UI copy is intentional: our default
 * the default graphite dark ramp reads as "Midnight", the violet dark ramp as "Aura",
 * the deep blue-slate dark ramp as "Dark" (theme id stays harbor), and the blue-gray dark ramp as
 * "Slate". The green pair (CRT-green dark + its mint light counterpart) reads
 * as "Dark Green" / "Light Green" and the red pair (blush light + plum-night
 * dark) as "Light Red" / "Dark Red" - the token classes on <html> stay
 * `dark` / `aura` / `harbor` / `phosphor` / `phosphor-light` / `sakura` /
 * `sakura-night` / `slate` (see globals.css). `swatch` is a fixed per-theme
 * preview class defined in globals.css.
 */
export const THEME_OPTIONS = [
  { value: 'light', label: 'Light', swatch: 'theme-swatch-light' },
  { value: 'harbor', label: 'Dark', swatch: 'theme-swatch-harbor' },
  { value: 'dark', label: 'Midnight', swatch: 'theme-swatch-dark' },
  { value: 'dusk', label: 'Dusk', swatch: 'theme-swatch-dusk' },
  { value: 'aura', label: 'Aura', swatch: 'theme-swatch-aura' },
  { value: 'phosphor', label: 'Dark Green', swatch: 'theme-swatch-phosphor' },
  { value: 'phosphor-light', label: 'Light Green', swatch: 'theme-swatch-phosphor-light' },
  { value: 'sakura', label: 'Light Red', swatch: 'theme-swatch-sakura' },
  { value: 'sakura-night', label: 'Dark Red', swatch: 'theme-swatch-sakura-night' },
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
 * Flip the theme with every CSS transition suppressed for one frame. Shell
 * chrome carries 150ms color transitions, which smear a theme change instead
 * of snapping it; styles are recalculated under the new theme while the
 * override is in place, then it is released on the next frame.
 */
function applyThemeWithoutTransitions(setTheme: (value: string) => void, value: string) {
  const style = document.createElement('style');
  style.textContent = '*{transition:none!important}';
  document.head.append(style);
  setTheme(value);
  requestAnimationFrame(() => {
    void document.documentElement.offsetHeight;
    style.remove();
  });
}

/**
 * Theme picker menu (Light / Dark / Midnight / Dusk / Aura / Dark Green / Light
 * Green / Light Red / Dark Red / Slate) on the BoardUI base Dropdown's menu
 * variant, so the rows are `menuitemradio`s with arrow-key navigation and the
 * menu closes on select. The caller supplies the trigger CONTENT via
 * `children` plus `triggerClassName`/`triggerAriaLabel` (the trigger button
 * itself is the React Aria pressable, so callers must not nest their own
 * <button>). Selection persists through next-themes (localStorage); the
 * active row is only marked once mounted to avoid a hydration mismatch
 * against the server-rendered theme.
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
      <DropdownTrigger aria-label={triggerAriaLabel} aria-haspopup='menu' className={triggerClassName}>
        {children}
      </DropdownTrigger>
      <DropdownMenu
        aria-label='Theme'
        placement={placement}
        className='w-44'
        header={<span className='px-2 pt-1 pb-0.5 text-body-2-medium text-text-secondary'>Theme</span>}
        selectionMode='single'
        disallowEmptySelection
        selectedKeys={mounted && theme ? [theme] : []}
        onSelectionChange={(keys) => {
          if (keys === 'all') return;
          const next = [...keys][0];
          if (typeof next === 'string') applyThemeWithoutTransitions(setTheme, next);
        }}
      >
        {THEME_OPTIONS.map((opt) => (
          <DropdownMenuItem key={opt.value} id={opt.value} textValue={opt.label} className='px-2 py-1.5'>
            <ThemeSwatch swatch={opt.swatch} />
            <span className='flex-1 text-body-2-medium'>{opt.label}</span>
            {mounted && theme === opt.value && (
              <RiCheckLine className='size-4 shrink-0 text-foreground-icon-primary' aria-hidden />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenu>
    </Dropdown>
  );
}
