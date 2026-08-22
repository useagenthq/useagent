"use client";

import { RiAddLine, RiErrorWarningLine, RiFlashlightLine, RiSearch2Line } from "@remixicon/react";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
  useState,
} from "react";
import * as Button from "@/components/ui/button";
import * as Input from "@/components/ui/input";
import * as SegmentedControl from "@/components/ui/segmented-control";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { relativeTime } from "@/utils/format";
import { AutomationCard } from "./automation-card";
import { AutomationHistoryDrawer } from "./automation-history-drawer";
import { AutomationOverview, EmptyAutomations } from "./automation-overview";
import { AutomationEditorModal } from "./new-schedule-modal";
import {
  createSchedule,
  deleteSchedule,
  fetchSchedules,
  runScheduleNow,
  updateSchedule,
  type CreateScheduleInput,
} from "./schedules-api";
import type { ScheduleRecord } from "./schedules-data";
import { useAutomationRecovery } from "./use-automation-recovery";

type Filter = "all" | "active" | "paused";
type IdSetSetter = Dispatch<SetStateAction<Set<string>>>;

function setBusy(setter: IdSetSetter, id: string, value: boolean) {
  setter((previous) => {
    const next = new Set(previous);
    if (value) next.add(id);
    else next.delete(id);
    return next;
  });
}

export function AutomationsView() {
  const [automations, setAutomations] = useState<ScheduleRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleRecord | null>(null);
  const [historyFor, setHistoryFor] = useState<ScheduleRecord | null>(null);
  const [running, setRunning] = useState<Set<string>>(() => new Set());
  const [mutating, setMutating] = useState<Set<string>>(() => new Set());

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchSchedules(signal);
      setAutomations(next);
      setHistoryFor((current) =>
        current ? (next.find((automation) => automation.id === current.id) ?? null) : null,
      );
      setError(null);
    } catch {
      if (signal?.aborted) return;
      setError("Couldn’t load automations. Check the connection and try again.");
    }
  }, []);

  useAutomationRecovery(load);

  useOrgChanges((change) => {
    if (change.type === "automation") void load();
  });

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (automations ?? []).filter((automation) => {
      const matchesStatus =
        filter === "all" ||
        (filter === "active" && automation.enabled) ||
        (filter === "paused" && !automation.enabled);
      const matchesQuery =
        !normalized ||
        automation.name.toLowerCase().includes(normalized) ||
        automation.prompt.toLowerCase().includes(normalized) ||
        automation.engine.toLowerCase().includes(normalized);
      return matchesStatus && matchesQuery;
    });
  }, [automations, filter, query]);

  const activeCount = automations?.filter((automation) => automation.enabled).length ?? 0;
  const latestActivity = automations
    ?.map((automation) => automation.last_fired_at)
    .filter((value): value is string => value !== null)
    .toSorted((left, right) => right.localeCompare(left))[0];

  const toggleAutomation = async (id: string, enabled: boolean) => {
    setBusy(setMutating, id, true);
    setAutomations((previous) =>
      previous?.map((item) => (item.id === id ? { ...item, enabled } : item)) ?? null,
    );
    try {
      const updated = await updateSchedule(id, { enabled });
      setAutomations((previous) =>
        previous?.map((item) => (item.id === id ? updated : item)) ?? null,
      );
      setError(null);
    } catch {
      setAutomations((previous) =>
        previous?.map((item) => (item.id === id ? { ...item, enabled: !enabled } : item)) ?? null,
      );
      setError("That status change didn’t save. The previous state was restored.");
    } finally {
      setBusy(setMutating, id, false);
    }
  };

  const runNow = async (id: string) => {
    setBusy(setRunning, id, true);
    try {
      await runScheduleNow(id);
      const automation = automations?.find((item) => item.id === id);
      if (automation) setHistoryFor(automation);
      setError(null);
      await load();
    } catch {
      setError("The automation couldn’t start. No schedule settings were changed.");
    } finally {
      setBusy(setRunning, id, false);
    }
  };

  const saveAutomation = async (input: CreateScheduleInput) => {
    if (editing) {
      const updated = await updateSchedule(editing.id, input);
      setAutomations((previous) =>
        previous?.map((item) => (item.id === editing.id ? updated : item)) ?? [updated],
      );
    } else {
      const created = await createSchedule(input);
      setAutomations((previous) => [created, ...(previous ?? [])]);
    }
    setError(null);
  };

  const removeAutomation = async (id: string) => {
    setBusy(setMutating, id, true);
    try {
      await deleteSchedule(id);
      setAutomations((previous) => previous?.filter((item) => item.id !== id) ?? []);
      if (historyFor?.id === id) setHistoryFor(null);
      setError(null);
    } catch {
      setError("The automation wasn’t deleted. Try again.");
    } finally {
      setBusy(setMutating, id, false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  return (
    <div className="mx-auto w-full max-w-[1040px] px-5 py-8 sm:px-8 sm:py-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-label-xs text-text-tertiary">
            <RiFlashlightLine className="size-4" aria-hidden /> Agent operations
          </div>
          <h1 className="mt-2 text-title-h4 text-text-primary">Automations</h1>
          <p className="mt-1 max-w-xl text-body-2-regular text-text-secondary">
            Schedule repeatable work, inspect every execution, and intervene when needed.
          </p>
        </div>
        <Button.Root
          variant="neutral"
          mode="filled"
          size="small"
          className="rounded-full"
          onClick={openCreate}
        >
          <Button.Icon as={RiAddLine} /> New automation
        </Button.Root>
      </header>

      <AutomationOverview
        active={activeCount}
        paused={(automations?.length ?? 0) - activeCount}
        latestActivity={latestActivity ? relativeTime(latestActivity) : "No runs yet"}
      />

      <section className="mt-6 overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-card">
        <div className="flex flex-col gap-3 border-b border-border-button-default px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <SegmentedControl.Root
            value={filter}
            onValueChange={(value) => setFilter(value as Filter)}
          >
            <SegmentedControl.List className="w-full sm:w-[290px]">
              <SegmentedControl.Trigger value="all">All</SegmentedControl.Trigger>
              <SegmentedControl.Trigger value="active">Active</SegmentedControl.Trigger>
              <SegmentedControl.Trigger value="paused">Paused</SegmentedControl.Trigger>
            </SegmentedControl.List>
          </SegmentedControl.Root>
          <Input.Root size="small" className="sm:w-72">
            <Input.Wrapper>
              <Input.Icon as={RiSearch2Line} />
              <Input.Input
                aria-label="Search automations"
                placeholder="Search automations…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Input.Wrapper>
          </Input.Root>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-b border-border-error-default/20 bg-background-tertiary-error px-4 py-3 text-body-2-regular text-text-secondary sm:px-5">
            <RiErrorWarningLine
              className="mt-0.5 size-4 shrink-0 text-text-error-primary"
              aria-hidden
            />
            <p className="flex-1">{error}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="text-body-2-medium text-text-error-primary"
            >
              Retry
            </button>
          </div>
        )}

        {automations === null ? (
          <div
            role="status"
            aria-label="Loading automations"
            className="space-y-px bg-border-button-default"
          >
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-36 animate-pulse bg-background-primary-default p-5">
                <div className="h-4 w-48 rounded bg-background-tertiary-default" />
                <div className="mt-3 h-3 w-2/3 rounded bg-background-secondary-default" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyAutomations filtered={automations.length > 0} onCreate={openCreate} />
        ) : (
          <div>
            {filtered.map((automation) => (
              <AutomationCard
                key={automation.id}
                schedule={automation}
                running={running.has(automation.id)}
                mutating={mutating.has(automation.id)}
                onToggle={(id, enabled) => void toggleAutomation(id, enabled)}
                onRunNow={(id) => void runNow(id)}
                onHistory={setHistoryFor}
                onEdit={(item) => {
                  setEditing(item);
                  setEditorOpen(true);
                }}
                onDelete={removeAutomation}
              />
            ))}
          </div>
        )}
      </section>

      <AutomationEditorModal
        open={editorOpen}
        schedule={editing}
        onClose={() => setEditorOpen(false)}
        onSave={saveAutomation}
      />
      <AutomationHistoryDrawer
        schedule={historyFor}
        running={historyFor ? running.has(historyFor.id) : false}
        onClose={() => setHistoryFor(null)}
        onRunNow={(id) => void runNow(id)}
      />
    </div>
  );
}
