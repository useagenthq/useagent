import {
  RiBookOpenLine,
  RiCheckboxCircleLine,
  RiPlayCircleLine,
  RiSparkling2Line,
} from "@remixicon/react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { AnalyticsBand } from "@/components/dashboard/analytics-band";
import {
  computeStats,
  extractDashboardSummary,
  extractRuns,
  recentRuns,
} from "@/components/dashboard/dashboard-data";
import { DashboardLiveRefresh } from "@/components/dashboard/dashboard-live-refresh";
import { RecentRunsTable } from "@/components/dashboard/recent-runs-table";
import {
  StatCard,
  StatCards,
  StatCardSkeleton,
  type StatItem,
} from "@/components/dashboard/stat-cards";
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
import { compactNumber } from "@/utils/format";

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

/**
 * The skills / knowledge counts stream in AFTER first paint inside a Suspense
 * boundary - the page must never block its runs-derived content on them.
 * Skills uses `view=picker`: the bare list ships every skill's full SKILL.md
 * sections (~18 MB for 1.7K skills) while this card only prints a count.
 * The 2000-row picker cap is fine for a compactNumber display.
 */
async function DashboardSummary() {
  const summary = extractDashboardSummary(await getJson("/api/dashboard/summary"));
  if (!summary) {
    return (
      <StatCards stats={[
        { icon: RiPlayCircleLine, label: "Total runs", value: "—" },
        { icon: RiCheckboxCircleLine, label: "Completed today", value: "—" },
      ]}>
        <StatCard stat={{ icon: RiBookOpenLine, label: "Knowledge records", value: "—" }} />
        <StatCard stat={{ icon: RiSparkling2Line, label: "Skills", value: "—" }} />
      </StatCards>
    );
  }
  const statItems: StatItem[] = [
    {
      icon: RiPlayCircleLine,
      label: "Total runs",
      value: compactNumber(summary.stats.total),
      delta: summary.stats.running > 0 ? `${summary.stats.running} live` : undefined,
      deltaColor: "blue",
    },
    {
      icon: RiCheckboxCircleLine,
      label: "Completed today",
      value: compactNumber(summary.stats.completedToday),
      delta: summary.stats.failed > 0 ? `${summary.stats.failed} failed` : undefined,
      deltaColor: "red",
    },
  ];
  return (
    <>
      <StatCards stats={statItems}>
        <StatCard stat={{ icon: RiBookOpenLine, label: "Knowledge records", value: compactNumber(summary.counts.knowledge) }} />
        <StatCard stat={{ icon: RiSparkling2Line, label: "Skills", value: compactNumber(summary.counts.skills) }} />
      </StatCards>
      {summary.stats.total > 0 && <AnalyticsBand daily={summary.daily} combo={summary.weekly} />}
    </>
  );
}

export default async function DashboardPage() {
  const runsData = await getJson("/api/runs?view=summary&all=1&limit=1000&include_active=1");

  const runs = extractRuns(runsData);

  // Per-project fleet lanes are derived from the same compact runs snapshot so the
  // grouping refreshes with the rest of the dashboard on DashboardLiveRefresh.
  const fleetRuns = extractFleetRuns(runsData);
  const lanes = groupIntoLanes(fleetRuns);
  const fleetStats = computeFleetStats(lanes.flatMap((lane) => lane.runs));

  const stats = computeStats(runs);
  const recent = recentRuns(runs);

  return (
    <AppShell sidebar={<ThreadSidebar active="dashboard" />}>
      <DashboardLiveRefresh />
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6 lg:p-8">
        <WelcomeHeader liveCount={stats.running} />
        <Suspense
          fallback={
            <StatCards stats={[]}>
              {Array.from({ length: 4 }, (_, index) => <StatCardSkeleton key={index} />)}
            </StatCards>
          }
        >
          <DashboardSummary />
        </Suspense>

        <section className="flex flex-col gap-3">
          <h2 className="text-headline-medium text-text-primary">Limits</h2>
          <FleetLimits />
        </section>

        <RecentRunsTable runs={recent} />

        {/* Tallest section last so the day-to-day cards stay above the fold. */}
        <section className="flex flex-col gap-3">
          <h2 className="text-headline-medium text-text-primary">Fleet by project</h2>
          <Fleet lanes={lanes} stats={fleetStats} />
        </section>
      </div>
    </AppShell>
  );
}
