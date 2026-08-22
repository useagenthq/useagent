"use client";

import {
  RiArrowDownSLine,
  RiDeleteBinLine,
  RiEditLine,
  RiHistoryLine,
  RiMore2Line,
  RiPlayLine,
  RiPlayMiniLine,
} from "@remixicon/react";
import { useState } from "react";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import {
  Dropdown,
  DropdownDivider,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { Switch } from "@/components/base/switch/switch";
import { cx } from "@/utils/cx";
import { relativeTime } from "@/utils/format";
import {
  cadenceLabel,
  engineLabel,
  scheduleZone,
  type ScheduleRecord,
} from "./schedules-data";

/**
 * One automation as a compact, stable-height list row: name + status chip,
 * instructions clamped to one line, and a single caption meta line (cadence,
 * mono cron, timezone, agent, last firing). The green edge bar is the semantic
 * "live" marker. The chevron reveals the full instructions plus the quieter
 * metadata (model, skill pin, repos); every action stays wired exactly - run,
 * enable toggle, history, edit, delete with inline confirm.
 */
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
  const [menuOpen, setMenuOpen] = useState(false);
  const busy = running || mutating;
  const cadence = cadenceLabel(schedule.cron);

  return (
    <article className="relative border-b border-border-button-default bg-background-primary-default transition-colors last:border-b-0 hover:bg-background-secondary-default/50">
      <div
        className={cx(
          "absolute inset-y-3 left-0 w-0.5 rounded-r-full",
          schedule.enabled ? "bg-green-500" : "bg-transparent",
        )}
        aria-hidden
      />

      <div className="flex items-center gap-3 py-3 pl-4 pr-4 sm:pl-5 sm:pr-5">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${schedule.name}`}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-icon-tertiary outline-none transition-colors hover:bg-background-tertiary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <RiArrowDownSLine
            className={cx("size-4 transition-transform duration-200", expanded && "rotate-180")}
            aria-hidden
          />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-body-medium text-text-primary">{schedule.name}</h2>
            <Chip variant="caption" color={schedule.enabled ? "lime" : "neutral"} className="shrink-0">
              {schedule.enabled ? "Active" : "Paused"}
            </Chip>
          </div>
          <p className="mt-0.5 line-clamp-1 text-caption-1-regular text-text-secondary">
            {schedule.prompt}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption-1-regular text-text-tertiary">
            {cadence !== schedule.cron && (
              <>
                <span className="text-text-secondary">{cadence}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <code className="rounded bg-background-tertiary-default px-1 font-mono text-caption-2-regular text-text-secondary">
              {schedule.cron}
            </code>
            <span aria-hidden>·</span>
            <span>{scheduleZone(schedule)}</span>
            <span aria-hidden>·</span>
            <span>{engineLabel(schedule.engine)}</span>
            <span aria-hidden>·</span>
            <span>
              {schedule.last_fired_at ? `Ran ${relativeTime(schedule.last_fired_at)}` : "Not run yet"}
            </span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="xs"
            className="hidden rounded-full sm:inline-flex"
            leadingIcon={RiPlayMiniLine}
            disabled={busy}
            onClick={() => onRunNow(schedule.id)}
            aria-label={`Run ${schedule.name} now`}
          >
            {running ? "Starting" : "Run now"}
          </Button>
          <Switch
            size="sm"
            isSelected={schedule.enabled}
            isDisabled={mutating}
            onChange={(enabled) => onToggle(schedule.id, enabled)}
            aria-label={`${schedule.name} ${schedule.enabled ? "active" : "paused"}`}
          />
          <Dropdown isOpen={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownTrigger
              aria-label={`More actions for ${schedule.name}`}
              className="flex size-8 items-center justify-center rounded-lg text-foreground-icon-tertiary transition-colors hover:bg-background-tertiary-default hover:text-text-primary"
            >
              <RiMore2Line className="size-4" aria-hidden />
            </DropdownTrigger>
            <DropdownPopover aria-label={`Actions for ${schedule.name}`} placement="bottom end" className="w-56">
              <DropdownItem
                className={cx(busy && "pointer-events-none opacity-50")}
                onSelect={() => {
                  setMenuOpen(false);
                  if (!busy) onRunNow(schedule.id);
                }}
              >
                <RiPlayLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
                <span className="text-body-2-medium">Run now</span>
              </DropdownItem>
              <DropdownItem
                onSelect={() => {
                  setMenuOpen(false);
                  onHistory(schedule);
                }}
              >
                <RiHistoryLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
                <span className="text-body-2-medium">View history</span>
              </DropdownItem>
              <DropdownItem
                onSelect={() => {
                  setMenuOpen(false);
                  onEdit(schedule);
                }}
              >
                <RiEditLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
                <span className="text-body-2-medium">Edit automation</span>
              </DropdownItem>
              <DropdownDivider />
              <DropdownItem
                className="text-text-error-primary"
                onSelect={() => {
                  setMenuOpen(false);
                  setConfirmingDelete(true);
                }}
              >
                <RiDeleteBinLine className="size-4 shrink-0" aria-hidden />
                <span className="text-body-2-medium">Delete</span>
              </DropdownItem>
            </DropdownPopover>
          </Dropdown>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border-button-default pb-4 pl-13 pr-4 pt-3 sm:pl-14 sm:pr-5">
          <p className="text-mono-label text-text-tertiary">Instructions</p>
          <p className="mt-1.5 whitespace-pre-wrap text-body-2-regular text-text-secondary">
            {schedule.prompt}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Chip variant="caption" color="soft">{schedule.model || "Default model"}</Chip>
            {schedule.skill_id && (
              <Chip variant="caption" color="soft">Skill v{schedule.skill_version ?? "?"}</Chip>
            )}
            {schedule.repos.map((repo) => (
              <Chip key={repo} variant="caption" color="soft">
                {repo}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {confirmingDelete && (
        <div className="flex flex-col gap-3 border-t border-border-button-default bg-background-tertiary-error px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <p className="text-body-2-medium text-text-primary">Delete this automation?</p>
            <p className="mt-0.5 text-caption-1-regular text-text-secondary">
              Existing runs stay in Active runs. The cadence and its history are removed.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" size="small" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="small"
              disabled={mutating}
              onClick={() => void onDelete(schedule.id)}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
