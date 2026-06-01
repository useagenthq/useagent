import {
  RiBookOpenLine,
  RiCheckboxCircleLine,
  RiPlayCircleLine,
  RiSparkling2Line,
} from "@remixicon/react";
import type { Metadata } from "next";
import { ContributionsCard } from "@/components/dashboard/contributions-card";
import { Suspense } from "react";
import { AnalyticsBand } from "@/components/dashboard/analytics-band";
import {
  buildHeatmap,
  computeStats,
  extractCount,
  extractRuns,
  recentRuns,
  runsPerDay,
  weeklyCombo,
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

/**
 * The skills / knowledge counts stream in AFTER first paint: /api/skills has
 * been observed at 6+ seconds, and the page must never block its runs-derived
 * content on it. Rendered inside a Suspense boundary in the stat grid.
 */
async function CountStats() {
  const [skillsData, knowledgeData] = await Promise.all([
    getJson("/api/skills"),
    getJson("/api/knowledge"),
  ]);
  return (
    <>
      <StatCard
        stat={{
          icon: RiBookOpenLine,
          label: "Knowledge records",
          value: compactNumber(extractCount(knowledgeData, "records")),
        }}
      />
      <StatCard
        stat={{
          icon: RiSparkling2Line,
          label: "Skills",
          value: compactNumber(extractCount(skillsData, "skills")),
        }}
      />
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
  const fortnight = runsPerDay(runs, 14);
  const heat = buildHeatmap(runs, 26);
  const recent = recentRuns(runs);
  const combo = weeklyCombo(runs);

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
  ];

  return (
    <AppShell sidebar={<ThreadSidebar active="dashboard" />}>
      <DashboardLiveRefresh />
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6 lg:p-8">
        <WelcomeHeader liveCount={stats.running} />
        <StatCards stats={statItems}>
          <Suspense
            fallback={
              <>
                <StatCardSkeleton />
                <StatCardSkeleton />
              </>
            }
          >
            <CountStats />
          </Suspense>
        </StatCards>

        {stats.total > 0 && <AnalyticsBand daily={fortnight} combo={combo} />}

        <section className="flex flex-col gap-3">
          <h2 className="text-headline-medium text-text-primary">Limits</h2>
          <FleetLimits />
        </section>

        <ContributionsCard cells={heat.cells} total={heat.total} />

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
