"use client";

import { useEffect, useRef } from "react";

/** Snapshot repairs for a missed live invalidation. Timed polling stops after 30 seconds. */
export const AUTOMATION_RECOVERY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

/**
 * Load immediately, then perform a finite set of snapshot repairs. Live org
 * invalidations remain the primary update path; focus/visibility fetches cover
 * changes made in chat while this view was backgrounded.
 */
export function useAutomationRecovery(
  refresh: (signal?: AbortSignal) => void | Promise<void>,
  recoveryKey: string | true | null = true,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (recoveryKey === null) return;
    const controller = new AbortController();
    const recover = () => void refreshRef.current(controller.signal);
    const timers = AUTOMATION_RECOVERY_DELAYS_MS.map((delay) =>
      window.setTimeout(recover, delay),
    );
    const recoverWhenVisible = () => {
      if (document.visibilityState === "visible") recover();
    };

    recover();
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recoverWhenVisible);

    return () => {
      controller.abort();
      for (const timer of timers) window.clearTimeout(timer);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recoverWhenVisible);
    };
  }, [recoveryKey]);
}
