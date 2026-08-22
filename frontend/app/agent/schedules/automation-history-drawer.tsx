"use client";

import { RiArrowRightUpLine, RiHistoryLine, RiPlayLine } from "@remixicon/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import * as Button from "@/components/ui/button";
import * as Drawer from "@/components/ui/drawer";
import * as StatusBadge from "@/components/ui/status-badge";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { relativeTime } from "@/utils/format";
import { fetchHistory } from "./schedules-api";
import { cadenceLabel, engineLabel, type FiringRecord, type ScheduleRecord } from "./schedules-data";
import { useAutomationRecovery } from "./use-automation-recovery";

function badgeStatus(status: string | null): "completed" | "failed" | "pending" | "disabled" {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "queued" || status === "running") return "pending";
  return "disabled";
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
        <Drawer.Header className="border-b">
          <div className="flex size-9 items-center justify-center rounded-xl bg-background-secondary-default">
            <RiHistoryLine className="size-5 text-text-secondary" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <Drawer.Title className="truncate">{schedule?.name ?? "Run history"}</Drawer.Title>
            {schedule && (
              <p className="mt-0.5 truncate text-caption-1-regular text-text-tertiary">
                {cadenceLabel(schedule.cron)} · {engineLabel(schedule.engine)}
              </p>
            )}
          </div>
        </Drawer.Header>

        <Drawer.Body className="p-5">
          {schedule && (
            <Button.Root
              className="w-full"
              variant="neutral"
              mode="stroke"
              size="small"
              disabled={running}
              onClick={() => onRunNow(schedule.id)}
            >
              <Button.Icon as={RiPlayLine} />
              {running ? "Starting run…" : "Run automation now"}
            </Button.Root>
          )}

          <div className="mt-6 flex items-center justify-between">
            <h2 className="text-body-2-medium text-text-primary">Executions</h2>
            {firings && firings.length > 0 && (
              <span className="text-label-xs text-text-tertiary">{firings.length} recorded</span>
            )}
          </div>

          {error && firings === null ? (
            <div className="mt-4 rounded-xl border border-border-error-default/30 bg-background-tertiary-error p-4">
              <p className="text-body-2-regular text-text-secondary">Couldn’t load execution history.</p>
              <button type="button" onClick={() => void load()} className="mt-2 text-body-2-medium text-text-error-primary">
                Try again
              </button>
            </div>
          ) : firings === null ? (
            <div role="status" className="mt-4 space-y-3" aria-label="Loading execution history">
              {[0, 1, 2].map((item) => (
                <div key={item} className="h-24 animate-pulse rounded-xl bg-background-secondary-default" />
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
            <ol className="relative mt-4 space-y-3 before:absolute before:bottom-5 before:left-[11px] before:top-5 before:w-px before:bg-border-button-default">
              {firings.map((firing) => {
                const status = firing.run_status ?? firing.status;
                return (
                  <li key={firing.id} className="relative pl-8">
                    <span
                      className="absolute left-1 top-4 z-10 size-4 rounded-full border-4 border-bg-white-0 bg-text-soft-400"
                      aria-hidden
                    />
                    <div className="rounded-xl border border-border-button-default bg-background-primary-default p-3.5 shadow-card">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <StatusBadge.Root variant="light" status={badgeStatus(status)}>
                            <StatusBadge.Dot />
                            {status}
                          </StatusBadge.Root>
                          <p className="mt-2 text-caption-1-regular text-text-tertiary">
                            {relativeTime(firing.fired_at)} · {firing.trigger === "cron" ? "Scheduled" : "Manual"}
                          </p>
                        </div>
                        <Link
                          href={`/session/${firing.run_id}`}
                          className="flex size-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-background-secondary-default hover:text-text-primary"
                          aria-label="Open run"
                        >
                          <RiArrowRightUpLine className="size-4" aria-hidden />
                        </Link>
                      </div>
                      {firing.run_summary && (
                        <p className="mt-3 line-clamp-3 text-body-2-regular text-text-secondary">
                          {firing.run_summary}
                        </p>
                      )}
                    </div>
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
