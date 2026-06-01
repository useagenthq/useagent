'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { useOrgChanges } from '@/hooks/use-org-changes';

/** Minimum spacing between server-snapshot refreshes. An active run streams a
 *  change per event; refreshing on each one kept the RSC page re-rendering
 *  (and re-fetching its data) almost continuously. */
const REFRESH_SPACING_MS = 4000;

/**
 * Refreshes the server-rendered dashboard snapshot when the run fleet changes,
 * collapsing event bursts to at most one refresh per REFRESH_SPACING_MS
 * (trailing, so the last event in a burst always lands).
 */
export function DashboardLiveRefresh() {
  const router = useRouter();
  const lastRefreshRef = useRef(0);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (pendingRef.current) clearTimeout(pendingRef.current);
    },
    [],
  );

  useOrgChanges((change) => {
    if (change.type !== 'run') return;
    if (pendingRef.current) return;
    const wait = Math.max(0, REFRESH_SPACING_MS - (Date.now() - lastRefreshRef.current));
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      lastRefreshRef.current = Date.now();
      router.refresh();
    }, wait);
  });

  return null;
}
