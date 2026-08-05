import type { Metadata } from "next";
import Link from "next/link";
import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import { AsteriskMark } from "@/components/foundations/brand/asterisk-mark";
import { StatusDot, type DotTone } from "@/components/shared/status-dot";
import { backendFetch } from "@/lib/backend-fetch";
import { fetchSkills } from "./skills-data";
import { relativeTime } from "@/utils/format";
import { NewTaskComposer } from "./new-task-composer";

export const metadata: Metadata = {
  title: "New task",
  description: "Describe a task and hand it to Skynet.",
};

interface RecentRun {
  id: string;
  prompt: string;
  status: string;
  created_at: string | number;
}

/** Three most-recent real runs for the "Recent tasks" list. Empty on any
 * failure so the section simply doesn't render (never a broken card). */
async function fetchRecentRuns(): Promise<RecentRun[]> {
  try {
    const res = await backendFetch("/api/runs", { cache: "no-store" });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    const runs = Array.isArray(data)
      ? (data as RecentRun[])
      : Array.isArray((data as { runs?: RecentRun[] })?.runs)
        ? (data as { runs: RecentRun[] }).runs
        : [];
    return runs
      .toSorted(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      .slice(0, 3);
  } catch {
    return [];
  }
}

const STATUS_DOT: Record<string, DotTone> = {
  completed: "success",
  running: "away",
  queued: "away",
  failed: "error",
};

function RecentTasks({ runs }: { runs: RecentRun[] }) {
  return (
    <section className="mt-10">
      <h2 className="text-mono-label px-1 text-text-soft-400">Recent tasks</h2>
      <div className="mt-3 flex flex-col gap-1.5">
        {runs.map((run) => (
          <Link
            key={run.id}
            href={`/session/${run.id}`}
            className="flex items-center gap-3 rounded-2xl border border-stroke-soft-200 bg-bg-white-0 px-3.5 py-3 outline-none transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
          >
            <StatusDot tone={STATUS_DOT[run.status] ?? "info"} />
            <span className="min-w-0 flex-1 truncate text-label-sm text-text-strong-950">
              {run.prompt}
            </span>
            <span className="shrink-0 text-paragraph-xs text-text-soft-400">
              {relativeTime(run.created_at)}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default async function NewTaskPage() {
  const [skills, recentRuns] = await Promise.all([fetchSkills(), fetchRecentRuns()]);

  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="new-task" />}>
      <div className="flex min-h-full flex-col items-center px-4 sm:px-6">
        <div className="w-full max-w-2xl py-10 sm:py-14">
          <div className="flex flex-col items-center gap-3 text-center">
            <AsteriskMark className="size-6 text-text-strong-950" />
            <p className="text-mono-label text-text-soft-400">New task</p>
            <h1 className="text-display-md text-text-strong-950">What should Skynet ship?</h1>
          </div>

          <div className="mt-8">
            <NewTaskComposer skills={skills} />
          </div>

          {recentRuns.length > 0 ? <RecentTasks runs={recentRuns} /> : null}
        </div>
      </div>
    </AppShell>
  );
}
