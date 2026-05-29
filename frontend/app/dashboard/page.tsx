import {
  RiBookOpenLine,
  RiCheckboxCircleLine,
  RiPlayCircleLine,
  RiSparkling2Line,
} from "@remixicon/react";
import type { Metadata } from "next";
import { ContributionsCard } from "@/components/dashboard/contributions-card";
import {
  buildHeatmap,
  computeStats,
  extractCount,
  extractRuns,
  runsPerDay,
} from "@/components/dashboard/dashboard-data";
import { DashboardLiveRefresh } from "@/components/dashboard/dashboard-live-refresh";
import { RecentRunsTable } from "@/components/dashboard/recent-runs-table";
import { RunsBarChartCard } from "@/components/dashboard/runs-bar-chart-card";
import { RunsTrendCard } from "@/components/dashboard/runs-trend-card";
import { StatCards, type StatItem } from "@/components/dashboard/stat-cards";
import { WelcomeHeader } from "@/components/dashboard/welcome-header";
import { Fleet } from "@/components/fleet/fleet-lanes";
import {
  computeStats as computeFleetStats,
  extractRuns as extractFleetRuns,
  groupIntoLanes,
} from "@/components/fleet/fleet-lanes-data";
import { FleetLimits } from "@/components/fleet/fleet-limits";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";
import { backendFetch } from "@/lib/backend-fetch";
import { compactNumber, estimatedTokens } from "@/utils/format";

export const metadata: Metadata = {
  title: "Dashboard - useAgent",
};

// Auth cookies are forwarded per-request, so this page must render dynamically.
export const dynamic = "force-dynamic";

async function getJson(path: string): Promise<unknown> {
  try {
    const res = await backendFetch(path, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function DashboardPage() {
  const [runsData, skillsData, knowledgeData] = await Promise.all([
    getJson("/api/runs"),
    getJson("/api/skills"),
    getJson("/api/knowledge"),
  ]);

  const runs = extractRuns(runsData);
  const skillsCount = extractCount(skillsData, "skills");
  const knowledgeCount = extractCount(knowledgeData, "records");

  // Per-project fleet lanes are derived from the same /api/runs snapshot so the
  // grouping refreshes with the rest of the dashboard on DashboardLiveRefresh.
  const fleetRuns = extractFleetRuns(runsData);
  const lanes = groupIntoLanes(fleetRuns);
  const fleetStats = computeFleetStats(lanes.flatMap((lane) => lane.runs));

  const stats = computeStats(runs);
  const week = runsPerDay(runs, 7);
  const fortnight = runsPerDay(runs, 14);
  const heat = buildHeatmap(runs, 26);

  const weekTotal = week.reduce((n, d) => n + d.total, 0);
  const fortnightTotal = fortnight.reduce((n, d) => n + d.total, 0);

  const statItems: StatItem[] = [
    {
      icon: RiPlayCircleLine,
      label: "Total runs",
      value: compactNumber(stats.total),
      delta: stats.running > 0 ? `${stats.running} live` : undefined,
      deltaColor: "blue",
    },
    {
      icon: RiCheckboxCircleLine,
      label: "Completed today",
      value: compactNumber(stats.completedToday),
      delta: stats.failed > 0 ? `${stats.failed} failed` : undefined,
      deltaColor: "red",
    },
    {
      icon: RiBookOpenLine,
      label: "Knowledge records",
      value: compactNumber(knowledgeCount),
    },
    {
      icon: RiSparkling2Line,
      label: "Skills",
      value: compactNumber(skillsCount),
    },
  ];

  return (
    <AppShell sidebar={<ThreadSidebar active="dashboard" />}>
      <DashboardLiveRefresh />
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6 lg:p-8">
        <WelcomeHeader liveCount={stats.running} />
        <StatCards stats={statItems} />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <RunsBarChartCard data={week} total={weekTotal} />
          <RunsTrendCard data={fortnight} tokensLabel={estimatedTokens(fortnightTotal)} />
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-headline-medium text-text-primary">Fleet by project</h2>
          <Fleet lanes={lanes} stats={fleetStats} />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-headline-medium text-text-primary">Limits</h2>
          <FleetLimits />
        </section>

        <ContributionsCard cells={heat.cells} total={heat.total} />

        <RecentRunsTable runs={runs} />
      </div>
    </AppShell>
  );
}
