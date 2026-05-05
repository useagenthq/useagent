import type { Metadata } from 'next';

import { AgentSidebar } from '@/components/shell/agent-sidebar';
import { AppShell } from '@/components/shell/app-shell';
import { RunsList } from './runs-list';
import { fetchRuns, type Run } from './runs-data';

export const metadata: Metadata = {
  title: 'Active runs',
  description: 'Live agent runs from the Skynet orchestrator.',
};

// Always render fresh — the runs list is live data.
export const dynamic = 'force-dynamic';

export default async function AgentRunsPage() {
  let initialRuns: Run[] = [];
  let initialError = false;

  try {
    initialRuns = await fetchRuns();
  } catch {
    initialError = true;
  }

  return (
    <AppShell activeTab='agent' sidebar={<AgentSidebar active='active-runs' />}>
      <RunsList initialRuns={initialRuns} initialError={initialError} />
    </AppShell>
  );
}
