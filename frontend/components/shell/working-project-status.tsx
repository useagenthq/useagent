"use client";

import { RiLoader4Line } from "@remixicon/react";
import { useEffect, useState } from "react";

import { statusTone, type Run } from "@/app/agent/runs/runs-data";
import { formatDuration } from "@/utils/format";
import { cn } from "@/utils/cn";

export type SidebarRun = Run & {
  readonly repo?: unknown;
  readonly repos?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
};

const ACTIVE_STATUSES = new Set([
  "active",
  "in_progress",
  "live",
  "pending",
  "queued",
  "running",
  "streaming",
]);

export function explicitRunRepos(run: SidebarRun): string[] {
  const repos = Array.isArray(run.repos) ? run.repos : run.repo ? [run.repo] : [];
  return repos.filter((repo): repo is string => typeof repo === "string" && repo.length > 0);
}

export function isSidebarActiveRun(run: SidebarRun): boolean {
  return ACTIVE_STATUSES.has(run.status.toLowerCase());
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function runElapsedMs(run: SidebarRun, now = Date.now()): number | null {
  if (typeof run.duration_ms === "number" && run.duration_ms > 0) return run.duration_ms;
  const startedAt = timestamp(run.created_at);
  if (startedAt === null) return null;
  return Math.max(0, now - startedAt);
}

export function activeRunByRepo(runs: readonly SidebarRun[]): Map<string, SidebarRun> {
  const byRepo = new Map<string, SidebarRun>();
  for (const run of runs) {
    if (!isSidebarActiveRun(run)) continue;
    for (const repo of explicitRunRepos(run)) {
      if (!byRepo.has(repo)) byRepo.set(repo, run);
    }
  }
  return byRepo;
}

export function runStatusLabel(run: SidebarRun): string {
  const status = run.status.toLowerCase();
  if (statusTone(run.status) === "live") return "Working";
  if (status === "queued" || status === "pending") return "Queued";
  if (statusTone(run.status) === "error") return "Failed";
  if (statusTone(run.status) === "success") return "Done";
  return "Idle";
}

export function WorkingProjectStatus({
  run,
  now,
}: {
  readonly run?: SidebarRun | null;
  readonly now?: number;
}) {
  const active = run ? isSidebarActiveRun(run) : false;
  const live = run ? statusTone(run.status) === "live" : false;
  const [clockNow, setClockNow] = useState(() => now ?? Date.now());

  useEffect(() => {
    if (now !== undefined) {
      setClockNow(now);
      return;
    }
    if (!live) return;
    const id = setInterval(() => setClockNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [live, now]);

  if (!run || !active) return null;

  const elapsed = runElapsedMs(run, now ?? clockNow);
  const label = runStatusLabel(run);
  const title = elapsed !== null ? `${label} for ${formatDuration(elapsed)}` : label;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-paragraph-xs tabular-nums",
        live ? "text-brand-orbit" : "text-text-soft-400",
      )}
      role={live ? "status" : undefined}
      title={title}
    >
      {live ? <RiLoader4Line className="size-3.5 animate-spin" aria-hidden /> : null}
      <span>{label}</span>
      {elapsed !== null ? <span>{formatDuration(elapsed)}</span> : null}
    </span>
  );
}
