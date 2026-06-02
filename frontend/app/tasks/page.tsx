import { RiListCheck2 } from "@remixicon/react";
import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";
import { fetchRepoProjects, fetchTasks } from "./tasks-api";
import { TasksBoard } from "./tasks-board";
import { ALL_PROJECTS, initialProjectFilter, type Task } from "./tasks-data";

export const metadata: Metadata = {
  title: "Tasks",
  description: "Durable, org-scoped tasks grouped per project on a Kanban board.",
};

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string | string[] }>;
}) {
  // Deep-link support: `/tasks?project=owner/name` opens straight onto that
  // project's board. Read the param server-side so the SSR fetch is already
  // scoped and the filter is preselected (no client-side filter flash).
  const { project } = await searchParams;
  const initialProject = typeof project === "string" ? project : undefined;
  const scope = initialProjectFilter(initialProject);
  const forProject = scope === ALL_PROJECTS ? undefined : scope;

  // SSR the real task board when the backend is up. A failed fetch becomes a
  // distinct, retryable `initialError` state - never swallowed into an empty
  // board, so an outage never reads as "no tasks yet". Repos are best-effort
  // (the board still works with the project keys already on tasks).
  let initial: Task[] = [];
  let initialRepos: string[] = [];
  let initialError = false;
  try {
    [initial, initialRepos] = await Promise.all([fetchTasks(forProject), fetchRepoProjects()]);
  } catch {
    initialError = true;
  }

  return (
    <AppShell sidebar={<LibrarySidebar active="tasks" />}>
      <div className="mx-auto w-full max-w-[1100px] px-6 py-8 sm:px-10 sm:py-10">
        <div className="flex items-start gap-2.5">
          <RiListCheck2 aria-hidden className="mt-0.5 size-5 text-foreground-icon-primary" />
          <div className="flex flex-col gap-0.5">
            <h1 className="text-title-2-medium text-text-primary">Tasks</h1>
            <p className="text-body-2-regular text-text-secondary">
              Durable tasks grouped per project - agents create them mid-run and they outlive the session
            </p>
          </div>
        </div>

        <div className="mt-8">
          <TasksBoard
            initial={initial}
            initialRepos={initialRepos}
            initialError={initialError}
            initialProject={initialProject}
          />
        </div>
      </div>
    </AppShell>
  );
}
