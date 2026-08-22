'use client';

// Ported and adapted from beUI (https://beui.dev/components/motion/theme-toggle;
// registry https://beui.dev/r/theme-toggle.json), MIT. The View Transition API
// circle reveal is beUI's; adapted for our stack: @remixicon/react instead of
// lucide, @/utils/cx, next-themes over our four-theme ramp (light + three dark
// palettes: dark/aura/harbor), and a self-contained Motion icon swap instead of
// beUI's ActionSwapIcon dependency chain. Neutral name per the vendoring rule.

import { RiMoonLine, RiSunLine } from '@remixicon/react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useTheme } from 'next-themes';
import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { cx } from '@/utils/cx';

const VT_STYLE_ID = 'motion-theme-toggle-vt';

// The reveal animates in CSS through the View Transition pseudo-elements, not a
// Motion spring: a circle wipes the new theme in from the toggle's position.
const VT_CSS = `
html[data-theme-vt="circle"]::view-transition-old(root){animation:none;mix-blend-mode:normal}
html[data-theme-vt="circle"]::view-transition-new(root){mix-blend-mode:normal;animation:motion-theme-circle 600ms cubic-bezier(0.4,0,0.2,1)}
@keyframes motion-theme-circle{
  from{clip-path:circle(0% at var(--theme-vt-origin,50% 50%))}
  to{clip-path:circle(150% at var(--theme-vt-origin,50% 50%))}
}
`;

/**
 * Theme toggle wired to our next-themes ramp. `light` is the only light theme;
 * `dark`/`aura`/`harbor` are dark palettes, so "dark" means any non-light theme
 * and toggling back to dark returns to the default Midnight (`dark`) ramp. The
 * three-way palette picker (ThemeMenu) still owns aura/harbor.
 */
export function useThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const reduce = useReducedMotion() ?? false;
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (document.getElementById(VT_STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = VT_STYLE_ID;
    el.textContent = VT_CSS;
    document.head.appendChild(el);
  }, []);

  const current = theme ?? resolvedTheme;
  const isDark = mounted && current !== 'light';

  const toggle = useCallback(
    (origin?: { x: number; y: number }) => {
      const next = isDark ? 'light' : 'dark';
      const supportsVt =
        !reduce && typeof document !== 'undefined' && 'startViewTransition' in document;
      if (!supportsVt) {
        setTheme(next);
        return;
      }
      const root = document.documentElement;
      if (origin) {
        const x = (origin.x / window.innerWidth) * 100;
        const y = (origin.y / window.innerHeight) * 100;
        root.style.setProperty('--theme-vt-origin', `${x}% ${y}%`);
      }
      root.dataset.themeVt = 'circle';
      const vt = (
        document as Document & {
          startViewTransition(cb: () => void): { finished: Promise<void> };
        }
      ).startViewTransition(() => setTheme(next));
      void vt.finished.finally(() => {
        delete root.dataset.themeVt;
      });
    },
    [isDark, reduce, setTheme],
  );

  return { isDark, mounted, toggle };
}

export type ThemeToggleProps = Omit<
  ComponentPropsWithoutRef<'button'>,
  'onClick' | 'children'
> & {
  /** Optional label rendered after the icon (turns the icon button into a row). */
  children?: ReactNode;
  iconClassName?: string;
};

/**
 * A beUI-derived animated theme toggle: a blurred Moon/Sun swap that triggers a
 * page-wide View Transition circle reveal from the toggle's position. With
 * `children` it reads as a labeled menu row; without, a compact icon button.
 */
export function ThemeToggle({ className, iconClassName, children, ...rest }: ThemeToggleProps) {
  const { isDark, mounted, toggle } = useThemeToggle();
  const ref = useRef<HTMLButtonElement>(null);

  return (
    <button
      ref={ref}
      type='button'
      aria-label={mounted && isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => {
        const rect = ref.current?.getBoundingClientRect();
        toggle(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined);
      }}
      className={cx('flex items-center gap-3', className)}
      {...rest}
    >
      <span className='relative flex size-5 shrink-0 items-center justify-center'>
        <AnimatePresence initial={false} mode='popLayout'>
          <motion.span
            key={mounted && isDark ? 'dark' : 'light'}
            initial={{ opacity: 0, filter: 'blur(4px)', scale: 0.7 }}
            animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }}
            exit={{ opacity: 0, filter: 'blur(4px)', scale: 0.7 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className='absolute inset-0 flex items-center justify-center'
          >
            {mounted && isDark ? (
              <RiSunLine className={cx('size-5', iconClassName)} aria-hidden />
            ) : (
              <RiMoonLine className={cx('size-5', iconClassName)} aria-hidden />
            )}
          </motion.span>
        </AnimatePresence>
      </span>
      {children}
    </button>
  );
}
