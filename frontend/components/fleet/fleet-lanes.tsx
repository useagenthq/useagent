"use client";

import { RiArrowRightSLine, RiFolderLine } from "@remixicon/react";
import Link from "next/link";
import { useState } from "react";
import { StatusDot } from "@/components/shared/status-dot";
import { Chip } from "@/components/base/badges/chip";
import { EntityShareRow } from "@/components/dashboard/entity-share-row";
import type { RunStatus } from "@/lib/runs";
import { cx } from "@/utils/cx";
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
  { color: "lime" | "yellow" | "rose" | "gray"; label: string }
> = {
  completed: { color: "lime", label: "Done" },
  running: { color: "yellow", label: "Working" },
  failed: { color: "rose", label: "Failed" },
  queued: { color: "gray", label: "Queued" },
};

function RunRow({ run }: { run: WorkspaceRun }) {
  const chip = STATUS_CHIP[run.status];
  return (
    <Link
      href={`/session/${run.id}`}
      className="flex items-center gap-3 rounded-lg px-2 py-2 outline-none transition-colors hover:bg-background-secondary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      <RunStatusDot status={run.status} />
      <span className="min-w-0 flex-1 truncate text-caption-1-medium text-text-primary">
        {run.prompt || "Untitled run"}
      </span>
      <span className="hidden font-mono text-caption-1-regular tabular-nums text-text-tertiary sm:inline">
        {formatDuration(run.duration_ms)}
      </span>
      <Chip color={chip.color}>
        {chip.label}
      </Chip>
    </Link>
  );
}

function LaneCard({ lane, max, defaultOpen }: { lane: LaneGroup; max: number; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const count = lane.runs.length;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full rounded-2lg px-1 py-1 text-left outline-none transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <EntityShareRow
          label={lane.label}
          title={lane.name}
          value={count}
          max={max}
          icon={RiFolderLine}
          leading={
            <RiArrowRightSLine
              aria-hidden
              className={cx(
                "size-4 shrink-0 text-text-tertiary transition-transform",
                open && "rotate-90",
              )}
            />
          }
          caption={
            lane.working > 0 ? (
              <span className="shrink-0 text-mono-label text-yellow-600">
                {lane.working} working
              </span>
            ) : undefined
          }
        />
      </button>

      {open && (
        <div className="pb-2 pl-1">
          {count > 0 ? (
            lane.runs.map((run) => <RunRow key={run.id} run={run} />)
          ) : (
            <p className="px-2 py-2 text-caption-1-regular text-text-tertiary">
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
  const maxCount = Math.max(1, ...lanes.map((lane) => lane.runs.length));

  return (
    <Panel>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-mono-label text-text-tertiary">Projects</span>
        <span className="text-caption-1-regular text-text-secondary">
          {stats.total} repository-backed run{stats.total === 1 ? "" : "s"} across {activeLanes}{" "}
          project
          {activeLanes === 1 ? "" : "s"} ·{" "}
          <span className={stats.failed > 0 ? "text-yellow-600" : "text-status-lime-text"}>
            {summary}
          </span>
        </span>
      </div>
      {lanes.length > 0 ? (
        <div className="flex flex-col gap-1">
          {lanes.map((lane, i) => (
            <LaneCard
              key={lane.name}
              lane={lane}
              max={maxCount}
              defaultOpen={i === 0 || lane.working > 0}
            />
          ))}
        </div>
      ) : (
        <p className="py-8 text-center text-body-2-regular text-text-tertiary">
          No repository-backed runs yet.
        </p>
      )}
    </Panel>
  );
}
