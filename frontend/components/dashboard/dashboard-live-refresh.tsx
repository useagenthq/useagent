'use client';

import { useRouter } from 'next/navigation';

import { useOrgChanges } from '@/hooks/use-org-changes';

/** Refreshes the server-rendered dashboard snapshot when the run fleet changes. */
export function DashboardLiveRefresh() {
  const router = useRouter();

  useOrgChanges((change) => {
    if (change.type === 'run') router.refresh();
  });

  return null;
}
