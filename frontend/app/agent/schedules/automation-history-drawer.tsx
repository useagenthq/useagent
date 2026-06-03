"use client";

import { RiArrowRightUpLine, RiPlayLine } from "@remixicon/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Chip, type ChipProps } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import * as Drawer from "@/components/base/drawer/drawer";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { relativeTime } from "@/utils/format";
import { fetchHistory } from "./schedules-api";
import { cadenceLabel, engineLabel, type FiringRecord, type ScheduleRecord } from "./schedules-data";
import { useAutomationRecovery } from "./use-automation-recovery";

/** Real run status → chip color; the label always shows the raw status. */
function statusChipColor(status: string): NonNullable<ChipProps["color"]> {
  if (status === "completed") return "lime";
  if (status === "failed" || status === "cancelled") return "rose";
  if (status === "running") return "cyan";
  if (status === "queued") return "yellow";
  return "neutral";
}

export function AutomationHistoryDrawer({
  schedule,
  running,
  onClose,
  onRunNow,
}: {
  schedule: ScheduleRecord | null;
  running: boolean;
  onClose: () => void;
  onRunNow: (id: string) => void;
}) {
  const [firings, setFirings] = useState<FiringRecord[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!schedule) return;
    try {
      setFirings(await fetchHistory(schedule.id, signal));
      setError(false);
    } catch {
      if (signal?.aborted) return;
      setError(true);
    }
  }, [schedule]);

  useEffect(() => {
    setFirings(null);
  }, [schedule?.id]);

  useAutomationRecovery(load, schedule?.id ?? null);

  useOrgChanges((change) => {
    if (!schedule) return;
    if (change.type === "automation" && change.automationId === schedule.id) {
      if (change.action === "deleted") {
        onClose();
        return;
      }
      void load();
      return;
    }
    if (change.type === "run" && firings?.some((firing) => firing.run_id === change.runId)) {
      void load();
    }
  });

  return (
    <Drawer.Root open={schedule !== null} onOpenChange={(next) => !next && onClose()}>
      <Drawer.Content className="max-w-[480px]">
        <Drawer.Header className="border-b border-border-button-default">
          <div className="min-w-0 flex-1">
            <Drawer.Title className="truncate text-body-medium text-text-primary">
              {schedule?.name ?? "Run history"}
            </Drawer.Title>
            {schedule && (
              <p className="mt-0.5 truncate text-caption-1-regular text-text-tertiary">
                {cadenceLabel(schedule.cron)} · {engineLabel(schedule.engine)}
              </p>
            )}
          </div>
        </Drawer.Header>

        <Drawer.Body className="p-5">
          {schedule && (
            <Button
              className="w-full"
              variant="secondary"
              size="small"
              leadingIcon={RiPlayLine}
              disabled={running}
              onClick={() => onRunNow(schedule.id)}
            >
              {running ? "Starting run…" : "Run automation now"}
            </Button>
          )}

          <div className="mt-6 flex items-baseline justify-between">
            <h2 className="text-body-2-medium text-text-primary">Executions</h2>
            {firings && firings.length > 0 && (
              <span className="text-caption-1-medium text-text-tertiary">{firings.length} recorded</span>
            )}
          </div>

          {error && firings === null ? (
            <div className="mt-4 rounded-xl bg-background-tertiary-error p-4">
              <p className="text-body-2-regular text-text-secondary">Couldn’t load execution history.</p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-2 text-body-2-medium text-text-error-primary"
              >
                Try again
              </button>
            </div>
          ) : firings === null ? (
            <div role="status" className="mt-4 space-y-2" aria-label="Loading execution history">
              {[0, 1, 2].map((item) => (
                <div key={item} className="h-16 animate-pulse rounded-xl bg-background-secondary-default" />
              ))}
            </div>
          ) : firings.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-border-button-default px-5 py-8 text-center">
              <p className="text-body-2-medium text-text-primary">No executions yet</p>
              <p className="mt-1 text-caption-1-regular text-text-tertiary">
                Start one manually or activate the cadence.
              </p>
            </div>
          ) : (
            <ol className="mt-4 space-y-2">
              {firings.map((firing) => {
                const status = firing.run_status ?? firing.status;
                return (
                  <li
                    key={firing.id}
                    className="rounded-xl bg-background-primary-default p-3 shadow-sm ring-1 ring-inset ring-border-button-default"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <Chip variant="caption" color={statusChipColor(status)} className="shrink-0">
                        {status}
                      </Chip>
                      <div className="flex min-w-0 items-center gap-1">
                        <span className="truncate text-caption-1-regular text-text-tertiary">
                          {relativeTime(firing.fired_at)} · {firing.trigger === "cron" ? "Scheduled" : "Manual"}
                        </span>
                        <Link
                          href={`/session/${firing.run_id}`}
                          aria-label="Open run"
                          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-icon-tertiary transition-colors hover:bg-background-secondary-default hover:text-text-primary"
                        >
                          <RiArrowRightUpLine className="size-4" aria-hidden />
                        </Link>
                      </div>
                    </div>
                    {firing.run_summary && (
                      <p className="mt-2 line-clamp-2 text-caption-1-regular text-text-secondary">
                        {firing.run_summary}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
  );
}
