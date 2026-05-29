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
        "group relative overflow-hidden border-b border-border-button-default bg-background-primary-default transition-colors last:border-b-0",
        schedule.enabled ? "hover:bg-background-secondary-default/60" : "opacity-80 hover:opacity-100",
      )}
    >
      <div
        className={cnExt(
          "absolute inset-y-4 left-0 w-0.5 rounded-r-full transition-colors",
          schedule.enabled ? "bg-green-500" : "bg-transparent",
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
            className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-border-button-default bg-background-primary-default text-text-tertiary shadow-card outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            <RiArrowDownSLine
              className={cnExt("size-4 transition-transform duration-200", expanded && "rotate-180")}
              aria-hidden
            />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-label-md text-text-primary">{schedule.name}</h2>
              <StatusBadge.Root
                variant="light"
                status={schedule.enabled ? "completed" : "disabled"}
              >
                <StatusBadge.Dot />
                {schedule.enabled ? "Active" : "Paused"}
              </StatusBadge.Root>
            </div>
            <p className="mt-1 line-clamp-1 text-body-2-regular text-text-secondary">
              {schedule.prompt}
            </p>

            <dl className="mt-4 grid gap-3 text-left sm:grid-cols-3 sm:gap-5">
              <div className="min-w-0">
                <dt className="flex items-center gap-1.5 text-label-xs text-text-tertiary">
                  <RiTimeLine className="size-3.5" aria-hidden /> Cadence
                </dt>
                <dd className="mt-1 truncate text-body-2-medium text-text-primary">
                  {cadenceLabel(schedule.cron)}
                </dd>
                <p className="mt-0.5 truncate text-caption-1-regular text-text-tertiary">
                  {scheduleZone(schedule)}
                </p>
              </div>
              <div className="min-w-0">
                <dt className="flex items-center gap-1.5 text-label-xs text-text-tertiary">
                  <RiRobot2Line className="size-3.5" aria-hidden /> Agent
                </dt>
                <dd className="mt-1 truncate text-body-2-medium text-text-primary">
                  {engineLabel(schedule.engine)}
                </dd>
                <p className="mt-0.5 truncate text-caption-1-regular text-text-tertiary">
                  {schedule.model || "Default model"}
                </p>
              </div>
              <div className="min-w-0">
                <dt className="text-label-xs text-text-tertiary">Last execution</dt>
                <dd className="mt-1 truncate text-body-2-medium text-text-primary">
                  {schedule.last_fired_at ? relativeTime(schedule.last_fired_at) : "Not run yet"}
                </dd>
                <p className="mt-0.5 truncate text-caption-1-regular text-text-tertiary">
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
                  className="flex size-8 items-center justify-center rounded-lg text-text-tertiary outline-none transition-colors hover:bg-background-tertiary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
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
                <Dropdown.Separator className="my-1 h-px bg-border-button-default" />
                <Dropdown.Item
                  onSelect={() => setConfirmingDelete(true)}
                  className="text-text-error-primary"
                >
                  <Dropdown.ItemIcon as={RiDeleteBinLine} className="text-text-error-primary" /> Delete
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
            <div className="ml-11 mt-4 border-t border-border-button-default pt-4">
              <div className="rounded-xl bg-background-secondary-default px-3.5 py-3">
                <p className="text-mono-label text-text-tertiary">Instructions</p>
                <p className="mt-1.5 whitespace-pre-wrap text-body-2-regular text-text-secondary">
                  {schedule.prompt}
                </p>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-caption-1-regular text-text-tertiary">
                <code className="rounded-md bg-background-tertiary-default px-1.5 py-0.5 font-mono">
                  {schedule.cron}
                </code>
                {schedule.skill_id && (
                  <span className="rounded-md border border-border-button-default px-1.5 py-0.5">
                    Skill v{schedule.skill_version ?? "?"}
                  </span>
                )}
                {schedule.repos.map((repo) => (
                  <span key={repo} className="rounded-md border border-border-button-default px-1.5 py-0.5">
                    {repo}
                  </span>
                ))}
              </div>

              {confirmingDelete && (
                <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border-error-default/30 bg-background-tertiary-error px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-body-2-medium text-text-primary">Delete this automation?</p>
                    <p className="mt-0.5 text-caption-1-regular text-text-secondary">
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
