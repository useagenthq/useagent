// Theme resolution: explicit prop → ancestor data-theme/.dark|.aura|.harbor|
// .light class (watched live) → prefers-color-scheme (subscribed live). `.aura`
// and `.harbor` are dark-scheme themes, so they resolve dark like `.dark`.
// SSR-safe via useSyncExternalStore: the server snapshot is dark, the
// client subscribes to the media query + a MutationObserver on the tree.

import type { RefObject } from 'react';
import { useCallback, useSyncExternalStore } from 'react';
import type { OrbTheme } from './types';

function ancestorTheme(el: Element | null): boolean | null {
  let node: Element | null = el;
  while (node) {
    const attr = node.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    if (node.classList.contains('dark')) return true;
    if (node.classList.contains('aura')) return true;
    if (node.classList.contains('harbor')) return true;
    if (node.classList.contains('light')) return false;
    node = node.parentElement;
  }
  return null;
}

function systemDark(): boolean {
  return typeof matchMedia === 'undefined' || matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolve the effective dark/light substrate for a mounted element. */
export function useResolvedDark(theme: OrbTheme, hostRef: RefObject<Element | null>): boolean {
  // Subscribe to the two live sources (OS theme + app-level class/data-theme
  // flips). Pinned themes need no subscription. setState never runs
  // synchronously in an effect — React pulls the value via getSnapshot.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (theme === 'dark' || theme === 'light') return () => {};

      const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
      mq?.addEventListener('change', onStoreChange);

      let mo: MutationObserver | null = null;
      if (typeof MutationObserver !== 'undefined') {
        mo = new MutationObserver(onStoreChange);
        mo.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-theme'],
          subtree: true,
        });
      }

      return () => {
        mq?.removeEventListener('change', onStoreChange);
        mo?.disconnect();
      };
    },
    [theme],
  );

  const getSnapshot = useCallback(() => {
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    return ancestorTheme(hostRef.current) ?? systemDark();
  }, [theme, hostRef]);

  // Server snapshot mirrors the historical pre-mount fallback: dark.
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}

/** Live `prefers-reduced-motion` — reduced users get a static frame. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onStoreChange: () => void) => {
      if (typeof matchMedia === 'undefined') return () => {};
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      mq.addEventListener('change', onStoreChange);
      return () => mq.removeEventListener('change', onStoreChange);
    },
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );
}
