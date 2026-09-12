import type { DotTone } from "@/components/shared/status-dot";
import { cleanPrompt } from "@/components/chat/types";
import type { ProductThreadStatus, ThreadRelationship } from "@useagent/agent-client";
import { effectiveSidebarRunStatus, type SidebarRun } from "./working-project-status";

export interface ThreadStatusPresentation {
  readonly label: "Running" | "Waiting" | "Queued" | "Failed" | "Cancelled" | "Completed";
  readonly priority: number;
  readonly dot: { tone: DotTone; pulse?: boolean; hollow?: boolean } | null;
}

export function effectiveThreadStatus(
  run: Pick<SidebarRun, "status" | "latest_status">,
): SidebarRun["status"] {
  return effectiveSidebarRunStatus(run);
}

export function threadStatusPresentation(
  status: SidebarRun["status"] | ProductThreadStatus,
): ThreadStatusPresentation {
  if (status === "running") {
    return { label: "Running", priority: 0, dot: { tone: "success", pulse: true } };
  }
  if (status === "queued") {
    return { label: "Queued", priority: 1, dot: { tone: "away", hollow: true } };
  }
  if (status === "waiting") {
    return { label: "Waiting", priority: 1, dot: { tone: "away", pulse: true } };
  }
  if (status === "failed") {
    return { label: "Failed", priority: 2, dot: { tone: "error" } };
  }
  if (status === "cancelled") {
    return { label: "Cancelled", priority: 2, dot: { tone: "neutral", hollow: true } };
  }
  return { label: "Completed", priority: 2, dot: null };
}

export function threadActivityTimestamp(
  run: Pick<SidebarRun, "created_at" | "updated_at"> &
    Partial<Pick<SidebarRun, "latest_created_at" | "latest_updated_at">>,
): number | null {
  for (const value of [
    run.latest_updated_at,
    run.latest_created_at,
    run.updated_at,
    run.created_at,
  ]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function activity(run: SidebarRun): number {
  return threadActivityTimestamp(run) ?? 0;
}

/** One authoritative ordering for every thread-discovery surface. */
export function rankThreads(runs: readonly SidebarRun[]): SidebarRun[] {
  const unique = new Map<string, SidebarRun>();
  for (const run of runs) {
    const previous = unique.get(run.id);
    if (!previous || activity(run) >= activity(previous)) unique.set(run.id, run);
  }

  return [...unique.values()].toSorted((a, b) => {
    const byStatus =
      threadStatusPresentation(effectiveThreadStatus(a)).priority -
      threadStatusPresentation(effectiveThreadStatus(b)).priority;
    if (byStatus !== 0) return byStatus;
    const byActivity = activity(b) - activity(a);
    return byActivity !== 0 ? byActivity : a.id.localeCompare(b.id);
  });
}

function searchableThreadText(run: SidebarRun): string {
  const repos = [
    ...run.repo_specs.map((spec) => spec.repo),
    ...run.repos,
    ...(run.repo ? [run.repo] : []),
  ];
  return `${cleanPrompt(run.prompt) || "Untitled run"} ${repos.join(" ")}`.toLowerCase();
}

/** Every query word must appear somewhere in the text, in any order, so
 *  "orbital heater" finds "Orbital H-200 heater". A blank query matches nothing. */
export function matchesEveryWord(text: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function findThreadMatches(runs: readonly SidebarRun[], query: string): SidebarRun[] {
  return rankThreads(runs).filter((run) => matchesEveryWord(searchableThreadText(run), query));
}

/** Delegated child threads (bot threads and the like) whose title matches the
 *  query. They live under a parent, so a search is the other way to reach them. */
export function findChildThreadMatches(
  relationships: readonly ThreadRelationship[],
  query: string,
): ThreadRelationship[] {
  return relationships
    .filter((item) => item.parentThreadId !== null && matchesEveryWord(item.title, query))
    .toSorted((a, b) => Date.parse(b.latestActivityAt) - Date.parse(a.latestActivityAt));
}

export function filterCommandEntries<T extends { readonly label: string }>(
  commands: readonly T[],
  query: string,
): T[] {
  if (!query.trim()) return [...commands];
  return commands.filter((command) => matchesEveryWord(command.label, query));
}
