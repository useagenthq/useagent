"use client";

import {
  RiArrowDownSLine,
  RiDeleteBinLine,
  RiHistoryLine,
  RiMore2Line,
  RiPlayLine,
  RiRobot2Line,
  RiTimeLine,
} from "@remixicon/react";
import { useState } from "react";
import * as Button from "@/components/ui/button";
import * as Dropdown from "@/components/ui/dropdown";
import * as StatusBadge from "@/components/ui/status-badge";
import * as Switch from "@/components/ui/switch";
import { cnExt } from "@/utils/cn";
import { relativeTime } from "@/utils/format";
import {
  cadenceLabel,
  engineLabel,
  scheduleZone,
  type ScheduleRecord,
} from "./schedules-data";

export function AutomationCard({
  schedule,
  running,
  mutating,
  onToggle,
  onRunNow,
  onHistory,
  onEdit,
  onDelete,
}: {
  schedule: ScheduleRecord;
  running: boolean;
  mutating: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onRunNow: (id: string) => void;
  onHistory: (schedule: ScheduleRecord) => void;
  onEdit: (schedule: ScheduleRecord) => void;
  onDelete: (id: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <article
      className={cnExt(
        "group relative overflow-hidden border-b border-stroke-soft-200 bg-bg-white-0 transition-colors last:border-b-0",
        schedule.enabled ? "hover:bg-bg-weak-50/60" : "opacity-80 hover:opacity-100",
      )}
    >
      <div
        className={cnExt(
          "absolute inset-y-4 left-0 w-0.5 rounded-r-full transition-colors",
          schedule.enabled ? "bg-success-base" : "bg-transparent",
        )}
        aria-hidden
      />

      <div className="px-4 py-4 sm:px-5">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${schedule.name}`}
            className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-stroke-soft-200 bg-bg-white-0 text-text-soft-400 shadow-regular-xs outline-none transition-colors hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
          >
            <RiArrowDownSLine
              className={cnExt("size-4 transition-transform duration-200", expanded && "rotate-180")}
              aria-hidden
            />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-label-md text-text-strong-950">{schedule.name}</h2>
              <StatusBadge.Root
                variant="light"
                status={schedule.enabled ? "completed" : "disabled"}
              >
                <StatusBadge.Dot />
                {schedule.enabled ? "Active" : "Paused"}
              </StatusBadge.Root>
            </div>
            <p className="mt-1 line-clamp-1 text-paragraph-sm text-text-sub-600">
              {schedule.prompt}
            </p>

            <dl className="mt-4 grid gap-3 text-left sm:grid-cols-3 sm:gap-5">
              <div className="min-w-0">
                <dt className="flex items-center gap-1.5 text-label-xs text-text-soft-400">
                  <RiTimeLine className="size-3.5" aria-hidden /> Cadence
                </dt>
                <dd className="mt-1 truncate text-label-sm text-text-strong-950">
                  {cadenceLabel(schedule.cron)}
                </dd>
                <p className="mt-0.5 truncate text-paragraph-xs text-text-soft-400">
                  {scheduleZone(schedule)}
                </p>
              </div>
              <div className="min-w-0">
                <dt className="flex items-center gap-1.5 text-label-xs text-text-soft-400">
                  <RiRobot2Line className="size-3.5" aria-hidden /> Agent
                </dt>
                <dd className="mt-1 truncate text-label-sm text-text-strong-950">
                  {engineLabel(schedule.engine)}
                </dd>
                <p className="mt-0.5 truncate text-paragraph-xs text-text-soft-400">
                  {schedule.model || "Default model"}
                </p>
              </div>
              <div className="min-w-0">
                <dt className="text-label-xs text-text-soft-400">Last execution</dt>
                <dd className="mt-1 truncate text-label-sm text-text-strong-950">
                  {schedule.last_fired_at ? relativeTime(schedule.last_fired_at) : "Not run yet"}
                </dd>
                <p className="mt-0.5 truncate text-paragraph-xs text-text-soft-400">
                  {schedule.last_fired_at ? "Open history for outcome" : "Ready for a manual run"}
                </p>
              </div>
            </dl>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button.Root
              type="button"
              variant="neutral"
              mode="stroke"
              size="xsmall"
              disabled={running || mutating}
              onClick={() => onRunNow(schedule.id)}
              aria-label={`Run ${schedule.name} now`}
              className="hidden rounded-full sm:inline-flex"
            >
              <Button.Icon as={RiPlayLine} className={running ? "animate-pulse" : undefined} />
              {running ? "Starting" : "Run now"}
            </Button.Root>
            <Switch.Root
              checked={schedule.enabled}
              disabled={mutating}
              onCheckedChange={(enabled) => onToggle(schedule.id, enabled)}
              aria-label={`${schedule.name} ${schedule.enabled ? "active" : "paused"}`}
            />
            <Dropdown.Root>
              <Dropdown.Trigger asChild>
                <button
                  type="button"
                  aria-label={`More actions for ${schedule.name}`}
                  className="flex size-8 items-center justify-center rounded-lg text-text-soft-400 outline-none transition-colors hover:bg-bg-soft-200 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
                >
                  <RiMore2Line className="size-4" aria-hidden />
                </button>
              </Dropdown.Trigger>
              <Dropdown.Content align="end" className="w-48">
                <Dropdown.Item onSelect={() => onRunNow(schedule.id)} disabled={running || mutating}>
                  <Dropdown.ItemIcon as={RiPlayLine} /> Run now
                </Dropdown.Item>
                <Dropdown.Item onSelect={() => onHistory(schedule)}>
                  <Dropdown.ItemIcon as={RiHistoryLine} /> View history
                </Dropdown.Item>
                <Dropdown.Item onSelect={() => onEdit(schedule)}>Edit automation</Dropdown.Item>
                <Dropdown.Separator className="my-1 h-px bg-stroke-soft-200" />
                <Dropdown.Item
                  onSelect={() => setConfirmingDelete(true)}
                  className="text-error-base"
                >
                  <Dropdown.ItemIcon as={RiDeleteBinLine} className="text-error-base" /> Delete
                </Dropdown.Item>
              </Dropdown.Content>
            </Dropdown.Root>
          </div>
        </div>

        <div
          className={cnExt(
            "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
            expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="ml-11 mt-4 border-t border-stroke-soft-200 pt-4">
              <div className="rounded-xl bg-bg-weak-50 px-3.5 py-3">
                <p className="text-mono-label text-text-soft-400">Instructions</p>
                <p className="mt-1.5 whitespace-pre-wrap text-paragraph-sm text-text-sub-600">
                  {schedule.prompt}
                </p>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-paragraph-xs text-text-soft-400">
                <code className="rounded-md bg-bg-soft-200 px-1.5 py-0.5 font-mono">
                  {schedule.cron}
                </code>
                {schedule.skill_id && (
                  <span className="rounded-md border border-stroke-soft-200 px-1.5 py-0.5">
                    Skill v{schedule.skill_version ?? "?"}
                  </span>
                )}
                {schedule.repos.map((repo) => (
                  <span key={repo} className="rounded-md border border-stroke-soft-200 px-1.5 py-0.5">
                    {repo}
                  </span>
                ))}
              </div>

              {confirmingDelete && (
                <div className="mt-3 flex flex-col gap-3 rounded-xl border border-error-base/30 bg-error-lighter px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-label-sm text-text-strong-950">Delete this automation?</p>
                    <p className="mt-0.5 text-paragraph-xs text-text-sub-600">
                      Existing runs stay in Active runs. The cadence and its history are removed.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button.Root
                      type="button"
                      variant="neutral"
                      mode="ghost"
                      size="xsmall"
                      onClick={() => setConfirmingDelete(false)}
                    >
                      Cancel
                    </Button.Root>
                    <Button.Root
                      type="button"
                      variant="error"
                      mode="filled"
                      size="xsmall"
                      disabled={mutating}
                      onClick={() => void onDelete(schedule.id)}
                    >
                      Delete
                    </Button.Root>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
