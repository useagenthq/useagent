"use client";

import { RiArrowRightUpLine } from "@remixicon/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { cadenceLabel } from "@/app/agent/schedules/schedules-data";
import { Chip, type ChipProps } from "@/components/base/badges/chip";
import * as Drawer from "@/components/base/drawer/drawer";
import { fetchRoutineHistory } from "./routines-api";
import { absoluteTime, relativeTime } from "./roster-model";
import { type ApiBot, type ApiFiring, type ApiRoutine, OFFLINE_MESSAGE } from "./types";
import { useNow } from "./use-now";

/** Real run status to chip color; the label always shows the raw status. */
function statusChipColor(status: string): NonNullable<ChipProps["color"]> {
  if (status === "completed") return "lime";
  if (status === "failed" || status === "cancelled") return "rose";
  if (status === "running") return "cyan";
  if (status === "queued") return "yellow";
  return "neutral";
}

/**
 * A routine's past runs, newest first (the order the history endpoint
 * returns): when each run fired, how it ended, and a link to the run.
 * A routine that has never run gets an empty state, not a blank list.
 */
export function RoutineHistoryList({ firings, now }: { firings: ApiFiring[]; now: number | null }) {
  if (firings.length === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-dashed border-border-button-default px-5 py-8 text-center">
        <p className="text-body-2-medium text-text-primary">No runs yet</p>
        <p className="mt-1 text-caption-1-regular text-text-tertiary">
          This routine has not fired yet. When it runs, the run will show up here.
        </p>
      </div>
    );
  }
  return (
    <ol className="mt-4 space-y-2">
      {firings.map((firing) => {
        const status = firing.run_status ?? firing.status;
        const firedLabel = absoluteTime(firing.fired_at, now) || relativeTime(firing.fired_at, now);
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
                  {firedLabel} · {firing.trigger === "cron" ? "Scheduled" : "Manual"}
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
              <p className="mt-2 line-clamp-2 text-caption-1-regular text-text-secondary">{firing.run_summary}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The routine history drawer: loads a routine's firings and lists them. */
export function RoutineHistoryDrawer({
  bot,
  routine,
  open,
  onClose,
}: {
  bot: ApiBot;
  routine: ApiRoutine;
  open: boolean;
  onClose: () => void;
}) {
  const now = useNow();
  const [firings, setFirings] = useState<ApiFiring[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFirings(await fetchRoutineHistory(bot.id, routine.id));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : OFFLINE_MESSAGE);
    }
  }, [bot.id, routine.id]);

  // Refetch on every open; on close keep the list so the slide-out does not flash a skeleton.
  useEffect(() => {
    if (!open) return;
    setFirings(null);
    setError(null);
    void load();
  }, [open, load]);

  return (
    <Drawer.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Drawer.Content className="max-w-[480px]">
        <Drawer.Header className="border-b border-border-button-default">
          <div className="min-w-0 flex-1">
            <Drawer.Title className="truncate text-body-medium text-text-primary">
              {routine.name}
            </Drawer.Title>
            <p className="mt-0.5 truncate text-caption-1-regular text-text-tertiary">{cadenceLabel(routine.cron)}</p>
          </div>
        </Drawer.Header>

        <Drawer.Body className="p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-body-2-medium text-text-primary">Runs</h2>
            {firings && firings.length > 0 && (
              <span className="text-caption-1-medium text-text-tertiary">{firings.length} recorded</span>
            )}
          </div>

          {error && firings === null ? (
            <div className="mt-4 rounded-xl bg-background-tertiary-error p-4">
              <p className="text-body-2-regular text-text-secondary">{error}</p>
              <button type="button" onClick={() => void load()} className="mt-2 text-body-2-medium text-text-error-primary">
                Try again
              </button>
            </div>
          ) : firings === null ? (
            <div role="status" className="mt-4 space-y-2" aria-label="Loading routine history">
              {[0, 1, 2].map((item) => (
                <div key={item} className="h-16 animate-pulse rounded-xl bg-background-secondary-default" />
              ))}
            </div>
          ) : (
            <RoutineHistoryList firings={firings} now={now} />
          )}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
  );
}
