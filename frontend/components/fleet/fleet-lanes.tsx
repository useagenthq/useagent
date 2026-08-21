"use client";

import { RiArrowRightSLine, RiFolderLine } from "@remixicon/react";
import Link from "next/link";
import { useState } from "react";
import { StatusDot } from "@/components/shared/status-dot";
import * as Badge from "@/components/ui/badge";
import type { RunStatus } from "@/lib/runs";
import { cnExt } from "@/utils/cn";
import { formatDuration } from "@/utils/format";
import type { FleetStats, LaneGroup, WorkspaceRun } from "./fleet-lanes-data";
import { Panel } from "./panel";

/** 12×12 status disc keyed to a run's status. */
function RunStatusDot({ status }: { status: RunStatus }) {
  if (status === "completed") return <StatusDot tone="success" />;
  if (status === "running") return <StatusDot tone="away" />;
  if (status === "failed") return <StatusDot tone="error" />;
  return <StatusDot tone="neutral" hollow />;
}

const STATUS_CHIP: Record<
  RunStatus,
  { color: "green" | "yellow" | "red" | "gray"; label: string }
> = {
  completed: { color: "green", label: "Done" },
  running: { color: "yellow", label: "Working" },
  failed: { color: "red", label: "Failed" },
  queued: { color: "gray", label: "Queued" },
};

function RunRow({ run }: { run: WorkspaceRun }) {
  const chip = STATUS_CHIP[run.status];
  return (
    <Link
      href={`/session/${run.id}`}
      className="flex items-center gap-3 rounded-lg px-2 py-2 outline-none transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
    >
      <RunStatusDot status={run.status} />
      <span className="min-w-0 flex-1 truncate text-label-xs text-text-strong-950">
        {run.prompt || "Untitled run"}
      </span>
      <span className="hidden font-mono text-paragraph-xs tabular-nums text-text-soft-400 sm:inline">
        {formatDuration(run.duration_ms)}
      </span>
      <Badge.Root variant="light" size="medium" color={chip.color}>
        {chip.label}
      </Badge.Root>
    </Link>
  );
}

function LaneCard({ lane, defaultOpen }: { lane: LaneGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const count = lane.runs.length;
  const caption = lane.working > 0 ? `${lane.working} working` : count > 0 ? "idle" : "empty";

  return (
    <div className="border-t border-stroke-soft-200 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
      >
        <RiArrowRightSLine
          aria-hidden
          className={cnExt(
            "size-4 shrink-0 text-text-soft-400 transition-transform",
            open && "rotate-90",
          )}
        />
        <RiFolderLine className="size-4 shrink-0 text-text-sub-600" aria-hidden />
        <span className="text-label-sm text-text-strong-950" title={lane.name}>
          {lane.label}
        </span>
        <span
          className={cnExt(
            "text-mono-label",
            lane.working > 0 ? "text-warning-base" : "text-text-soft-400",
          )}
        >
          {caption}
        </span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {lane.runs.map((run) => (
            <RunStatusDot key={run.id} status={run.status} />
          ))}
        </span>
      </button>

      {open && (
        <div className="pb-2 pl-1">
          {count > 0 ? (
            lane.runs.map((run) => <RunRow key={run.id} run={run} />)
          ) : (
            <p className="px-2 py-2 text-paragraph-xs text-text-soft-400">
              No runs in this project yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function Fleet({ lanes, stats }: { lanes: LaneGroup[]; stats: FleetStats }) {
  const activeLanes = lanes.filter((lane) => lane.runs.length > 0).length;
  const summary = stats.failed > 0 ? "needs attention" : "all clear";

  return (
    <Panel>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-mono-label text-text-soft-400">Projects</span>
        <span className="text-paragraph-xs text-text-sub-600">
          {stats.total} repository-backed run{stats.total === 1 ? "" : "s"} across {activeLanes}{" "}
          project
          {activeLanes === 1 ? "" : "s"} ·{" "}
          <span className={stats.failed > 0 ? "text-warning-base" : "text-success-base"}>
            {summary}
          </span>
        </span>
      </div>
      {lanes.length > 0 ? (
        <div>
          {lanes.map((lane, i) => (
            <LaneCard key={lane.name} lane={lane} defaultOpen={i === 0 || lane.working > 0} />
          ))}
        </div>
      ) : (
        <p className="py-8 text-center text-paragraph-sm text-text-soft-400">
          No repository-backed runs yet.
        </p>
      )}
    </Panel>
  );
}
