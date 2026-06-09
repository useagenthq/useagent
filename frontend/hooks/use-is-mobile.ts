"use client";

import { useCallback, useSyncExternalStore } from "react";

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

// Tailwind's `md` breakpoint boundary: below 768px the shell switches to its
// mobile grammar (the session surfaces rail becomes a bottom slide-over sheet).
const MOBILE_QUERY = "(max-width: 767px)";

/**
 * True below Tailwind's `md` breakpoint. The server snapshot is `false`, so SSR
 * and the first client render agree; CSS (`max-md:*`) owns first-paint visuals
 * while this hook gates only behavior (aria-hidden/inert, default tab mapping).
 */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

// The tablet band: md..<xl (768-1279px). Wide enough for the session split,
// not wide enough for the full 256px sidebar beside it.
const TABLET_BAND_QUERY = "(min-width: 768px) and (max-width: 1279px)";

/**
 * True inside the tablet band (same SSR contract as `useIsMobile`: server
 * snapshot `false`, the hook gates behavior only). The shell folds the sidebar
 * to the compact rail on entry so the session split keeps its room.
 */
export function useIsTabletBand(): boolean {
  return useMediaQuery(TABLET_BAND_QUERY);
}
