"use client";

import { useEffect, useState } from "react";

/**
 * Wall-clock for relative times, resolved after mount so the server and the
 * first client render agree (no hydration mismatch across a minute boundary).
 */
export function useNow(intervalMs = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
