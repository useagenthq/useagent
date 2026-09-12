"use client";

import { useSidebar } from "@/components/sidebar-kit/sidebar";

/**
 * Whether the rail shows its folded icon layout. The desktop rail folds when the
 * sidebar is collapsed; the mobile sheet always shows the full layout, whatever
 * the desktop state happens to be (auto-collapse, a remembered preference).
 */
export function railFolded(state: "expanded" | "collapsed", isMobile: boolean): boolean {
  return !isMobile && state === "collapsed";
}

export function useRailFolded(): boolean {
  const { state, isMobile } = useSidebar();
  return railFolded(state, isMobile);
}
