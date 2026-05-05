'use client';

import { useEffect, useState } from 'react';

import { StatusDot } from '@/components/shared/status-dot';
import {
  type Run,
  TONE_TO_DOT,
  fetchRuns,
  statusTone,
} from '@/app/agent/runs/runs-data';
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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await fetchRuns();
        if (!cancelled) setRuns(next);
      } catch {
        // Ambient list — keep the last good runs on a transient failure.
      }
    }
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

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
