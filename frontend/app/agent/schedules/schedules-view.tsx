"use client";

import {
  RiCalendarScheduleLine,
  RiHistoryLine,
  RiPlayLine,
  RiRobot2Line,
} from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import * as Drawer from "@/components/ui/drawer";
import * as Switch from "@/components/ui/switch";
import { StatusDot } from "@/components/shared/status-dot";
import { cnExt } from "@/utils/cn";
import { relativeTime } from "@/utils/format";
import { NewScheduleModal } from "./new-schedule-modal";
import {
  createSchedule,
  fetchHistory,
  fetchSchedules,
  runScheduleNow,
  updateSchedule,
  type CreateScheduleInput,
} from "./schedules-api";
import {
  engineLabel,
  runTone,
  type FiringRecord,
  type ScheduleRecord,
} from "./schedules-data";

/* -------------------------------------------------------------------------- */
/*  Chips                                                                       */
/* -------------------------------------------------------------------------- */

/** Monospace cron pill — "0 9 * * 1". */
function CronChip({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center rounded-md bg-bg-soft-200 px-1.5 py-0.5 font-mono text-label-xs text-text-sub-600">
      {children}
    </span>
  );
}

function EngineChip({ engine }: { engine: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-label-xs text-text-soft-400">
      <RiRobot2Line className="size-3.5 shrink-0" aria-hidden />
      {engineLabel(engine)}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Row                                                                         */
/* -------------------------------------------------------------------------- */

function ScheduleRow({
  schedule,
  busy,
  onToggle,
  onRunNow,
  onHistory,
}: {
  schedule: ScheduleRecord;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onRunNow: (id: string) => void;
  onHistory: (schedule: ScheduleRecord) => void;
}) {
  return (
    <article
      className={cnExt(
        "rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-4 shadow-regular-xs transition-colors",
        schedule.enabled ? "hover:border-stroke-sub-300" : "opacity-75",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-stroke-soft-200 bg-bg-weak-50">
            <RiCalendarScheduleLine aria-hidden className="size-5 text-text-sub-600" />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="truncate text-label-sm text-text-strong-950">{schedule.name}</h3>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <CronChip>{schedule.cron}</CronChip>
              <EngineChip engine={schedule.engine} />
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onRunNow(schedule.id)}
            disabled={busy}
            aria-label={`Run ${schedule.name} now`}
            className="flex size-7 items-center justify-center rounded-lg text-text-soft-400 transition-colors hover:bg-bg-soft-200 hover:text-text-sub-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RiPlayLine className={cnExt("size-4", busy && "animate-pulse")} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onHistory(schedule)}
            aria-label={`History for ${schedule.name}`}
            className="flex size-7 items-center justify-center rounded-lg text-text-soft-400 transition-colors hover:bg-bg-soft-200 hover:text-text-sub-600"
          >
            <RiHistoryLine className="size-4" aria-hidden />
          </button>
          <Switch.Root
            checked={schedule.enabled}
            onCheckedChange={(enabled) => onToggle(schedule.id, enabled)}
            aria-label={`${schedule.name} ${schedule.enabled ? "on" : "off"}`}
          />
        </div>
      </div>

      <div className="mt-3.5 flex items-center gap-2 border-t border-stroke-soft-200 pt-3">
        {schedule.enabled ? (
          <>
            <StatusDot tone="success" />
            <p className="text-paragraph-xs text-text-sub-600">
              Enabled ·{" "}
              {schedule.last_fired_at
                ? `last fired ${relativeTime(schedule.last_fired_at)}`
                : "waiting for next cron match"}
            </p>
          </>
        ) : (
          <>
            <StatusDot tone="neutral" hollow />
            <p className="text-paragraph-xs text-text-soft-400">Disabled - won’t run on schedule</p>
          </>
        )}
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  History drawer                                                              */
/* -------------------------------------------------------------------------- */

function HistoryDrawer({
  schedule,
  onClose,
}: {
  schedule: ScheduleRecord | null;
  onClose: () => void;
}) {
  const [firings, setFirings] = useState<FiringRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!schedule) return;
    let alive = true;
    setFirings(null);
    setError(null);
    fetchHistory(schedule.id)
      .then((rows) => alive && setFirings(rows))
      .catch(() => alive && setError("Couldn’t load history."));
    return () => {
      alive = false;
    };
  }, [schedule]);

  return (
    <Drawer.Root open={schedule !== null} onOpenChange={(next) => !next && onClose()}>
      <Drawer.Content>
        <Drawer.Header className="border-b">
          <Drawer.Title>{schedule ? `History · ${schedule.name}` : "History"}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="p-5">
          {error ? (
            <p className="text-paragraph-sm text-text-sub-600">{error}</p>
          ) : firings === null ? (
            <p className="text-paragraph-sm text-text-soft-400">Loading…</p>
          ) : firings.length === 0 ? (
            <p className="text-paragraph-sm text-text-soft-400">
              No runs yet. Use “Run now” or enable the automation.
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {firings.map((f) => (
                <li
                  key={f.id}
                  className="flex flex-col gap-1.5 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-label-sm text-text-strong-950">
                      <StatusDot tone={runTone(f.run_status)} />
                      {f.run_status ?? f.status}
                    </span>
                    <span className="rounded-md bg-bg-soft-200 px-1.5 py-0.5 text-label-xs text-text-sub-600">
                      {f.trigger}
                    </span>
                  </div>
                  <p className="text-paragraph-xs text-text-soft-400">{relativeTime(f.fired_at)}</p>
                  {f.run_summary && (
                    <p className="text-paragraph-xs text-text-sub-600">{f.run_summary}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                        */
/* -------------------------------------------------------------------------- */

export function SchedulesView() {
  const [list, setList] = useState<ScheduleRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [historyFor, setHistoryFor] = useState<ScheduleRecord | null>(null);
  const [firing, setFiring] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    fetchSchedules()
      .then((rows) => {
        setList(rows);
        setError(null);
      })
      .catch(() => setError("Couldn’t load automations. Is the backend running?"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onToggle = async (id: string, enabled: boolean) => {
    // Optimistic — revert on failure.
    setList((prev) =>
      prev ? prev.map((s) => (s.id === id ? { ...s, enabled } : s)) : prev,
    );
    try {
      await updateSchedule(id, { enabled });
    } catch {
      setList((prev) =>
        prev ? prev.map((s) => (s.id === id ? { ...s, enabled: !enabled } : s)) : prev,
      );
    }
  };

  const onCreate = async (input: CreateScheduleInput) => {
    const created = await createSchedule(input);
    setList((prev) => (prev ? [created, ...prev] : [created]));
  };

  const onRunNow = async (id: string) => {
    setFiring((prev) => new Set(prev).add(id));
    try {
      await runScheduleNow(id);
      // Open history so the just-created run is visible immediately.
      const schedule = list?.find((s) => s.id === id) ?? null;
      if (schedule) setHistoryFor(schedule);
    } catch {
      /* swallow — a failed manual fire is non-fatal; the list stays as-is */
    } finally {
      setFiring((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="mx-auto w-full max-w-[880px] px-6 py-8 sm:px-10 sm:py-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <RiCalendarScheduleLine aria-hidden className="mt-0.5 size-5 text-text-strong-950" />
          <div className="flex flex-col gap-0.5">
            <h1 className="text-display-sm text-text-strong-950">Automations</h1>
            <p className="text-paragraph-sm text-text-sub-600">
              Recurring runs Skynet starts on its own, on a cron cadence
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-full bg-bg-strong-950 px-4 text-label-sm text-text-white-0 shadow-regular-xs outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2"
        >
          New automation
        </button>
      </div>

      {/* Info banner */}
      <div className="mt-6 flex items-start gap-2.5 rounded-2xl border border-stroke-soft-200 bg-bg-weak-50 px-4 py-3">
        <RiRobot2Line aria-hidden className="mt-0.5 size-[18px] shrink-0 text-text-soft-400" />
        <p className="text-paragraph-xs text-text-sub-600">
          <span className="text-mono-label mr-1.5 text-text-soft-400">Automations</span>
          New automations are created disabled. Enable one and its prompt fires as a
          real run on each cron match; runs appear in Active runs.
        </p>
      </div>

      {/* List */}
      {error ? (
        <p className="mt-10 text-paragraph-sm text-text-sub-600">{error}</p>
      ) : list === null ? (
        <p className="mt-10 text-paragraph-sm text-text-soft-400">Loading…</p>
      ) : list.length > 0 ? (
        <div className="mt-6 flex flex-col gap-3">
          {list.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              busy={firing.has(schedule.id)}
              onToggle={onToggle}
              onRunNow={onRunNow}
              onHistory={setHistoryFor}
            />
          ))}
        </div>
      ) : (
        <p className="mt-10 text-paragraph-sm text-text-sub-600">
          No automations yet. Create one to have Skynet run it on a cron cadence.
        </p>
      )}

      <NewScheduleModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreate={onCreate}
      />
      <HistoryDrawer schedule={historyFor} onClose={() => setHistoryFor(null)} />
    </div>
  );
}
