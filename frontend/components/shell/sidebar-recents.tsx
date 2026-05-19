'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  type Run,
  TONE_TO_DOT,
  fetchRuns,
  statusTone,
} from '@/app/agent/runs/runs-data';
import { StatusDot } from '@/components/shared/status-dot';
import { useOrgChanges } from '@/hooks/use-org-changes';
import { SidebarNavItem, SidebarSectionLabel } from './sidebar-nav';

const POLL_MS = 30_000;
const MAX = 8;

/**
 * The sidebar "Recents" list, wired to real runs. Reuses the Active-runs data
 * layer (`fetchRuns` + `statusTone` + the shared `TONE_TO_DOT` map) rather than
 * duplicating the fetch, and renders the newest runs as links into their
 * session. Client leaf so the server `AgentSidebar` stays static; renders
 * nothing until at least one run exists (no empty-section furniture).
 */
export function SidebarRecents() {
  const [runs, setRuns] = useState<Run[]>([]);

  const load = useCallback(async (signal?: AbortSignal) => {
      try {
        setRuns(await fetchRuns(signal));
      } catch {
        // Ambient list — keep the last good runs on a transient failure.
      }
  }, []);

  useOrgChanges((change) => {
    if (change.type === 'run') void load();
  });

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const id = setInterval(() => void load(controller.signal), POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [load]);

  if (runs.length === 0) return null;

  return (
    <>
      <SidebarSectionLabel>Recents</SidebarSectionLabel>
      {runs.slice(0, MAX).map((run) => (
        <SidebarNavItem
          key={run.id}
          href={`/session/${run.id}`}
          label={run.prompt || 'Untitled run'}
          leading={<StatusDot {...TONE_TO_DOT[statusTone(run.status)]} />}
        />
      ))}
    </>
  );
}
