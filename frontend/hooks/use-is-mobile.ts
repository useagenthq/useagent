"use client";

import { useSyncExternalStore } from "react";

// Tailwind's `md` breakpoint boundary: below 768px the shell switches to its
// mobile grammar (the session surfaces rail becomes a bottom slide-over sheet).
const MOBILE_QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(MOBILE_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

/**
 * True below Tailwind's `md` breakpoint. The server snapshot is `false`, so SSR
 * and the first client render agree; CSS (`max-md:*`) owns first-paint visuals
 * while this hook gates only behavior (aria-hidden/inert, default tab mapping).
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}
