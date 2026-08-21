import { OrbitKnotMark } from "@/components/foundations/brand/orbit-knot-mark";
import type { Metadata } from "next";
import Link from "next/link";
import { type DotTone, StatusDot } from "@/components/shared/status-dot";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";
import { backendFetch } from "@/lib/backend-fetch";
import { relativeTime } from "@/utils/format";
import { NewTaskComposer } from "./new-task-composer";
import { fetchSkills } from "./skills-data";

export const metadata: Metadata = {
  title: "New thread",
  description: "Start a direct conversation or a sandbox-backed task with useAgent.",
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
      .toSorted((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
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

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string | string[]; prompt?: string | string[] }>;
}) {
  const params = await searchParams;
  const requestedRepo = params.repo;
  const initialRepository = typeof requestedRepo === "string" ? requestedRepo : null;
  // Deep-link prefill: surfaces like "Discuss PR" open the composer with the
  // prompt already drafted (e.g. the repo + PR number the agent should read).
  const initialPrompt = typeof params.prompt === "string" ? params.prompt : "";
  const [skills, recentRuns] = await Promise.all([fetchSkills(), fetchRecentRuns()]);

  return (
    <AppShell sidebar={<ThreadSidebar active="new" />}>
      <div className="flex min-h-full flex-col items-center px-4 sm:px-6">
        <div className="w-full max-w-3xl py-10 sm:py-14">
          <div className="flex flex-col items-center gap-3 text-center">
            <OrbitKnotMark className="size-7" />
            <p className="text-mono-label text-text-soft-400">New thread</p>
            <h1 className="text-display-md text-text-strong-950">What should your agent do?</h1>
          </div>

          <div className="mt-8">
            <NewTaskComposer
              skills={skills}
              initialRepository={initialRepository}
              initialPrompt={initialPrompt}
            />
          </div>

          {recentRuns.length > 0 ? <RecentTasks runs={recentRuns} /> : null}
        </div>
      </div>
    </AppShell>
  );
}
