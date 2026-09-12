"use client";

import { RiAddLine, RiDeleteBinLine, RiPlayLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cadenceLabel } from "@/app/agent/schedules/schedules-data";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Switch } from "@/components/base/switch/switch";
import * as Textarea from "@/components/base/textarea/textarea";
import { cx } from "@/utils/cx";
import { createRoutine, deleteRoutine, fetchRoutines, runRoutineNow, updateRoutine } from "./routines-api";
import { relativeTime } from "./roster-model";
import type { ApiBot, ApiRoutine } from "./types";
import { useNow } from "./use-now";

/** The reference's four cadences; a custom cron is one field away. */
const CADENCES = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily 9:00", cron: "0 9 * * *" },
  { label: "Weekdays 9:00", cron: "0 9 * * 1-5" },
  { label: "Mondays 9:00", cron: "0 9 * * 1" },
] as const;

function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

function RoutineRow({ bot, routine, onChange }: { bot: ApiBot; routine: ApiRoutine; onChange: () => void }) {
  const router = useRouter();
  const now = useNow();
  const [busy, setBusy] = useState<"toggle" | "run" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const guard = async (kind: "toggle" | "run" | "delete", work: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await work();
      onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border-button-default p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-body-2-medium text-text-primary">{routine.name}</p>
          <p className="text-caption-1-regular text-text-tertiary">
            {cadenceLabel(routine.cron)}
            {routine.lastFiredAt ? ` · last run ${relativeTime(routine.lastFiredAt, now) || "just now"}` : " · never run"}
          </p>
        </div>
        <Switch
          size="sm"
          aria-label={`${routine.name} enabled`}
          isSelected={routine.enabled}
          onChange={(enabled: boolean) => void guard("toggle", async () => { await updateRoutine(bot.id, routine.id, { enabled }); })}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => void guard("run", async () => { await runRoutineNow(bot.id, routine.id); router.refresh(); })}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-caption-1-medium text-text-secondary transition-colors hover:bg-background-primary-hover hover:text-text-primary"
        >
          <RiPlayLine className="size-3.5" aria-hidden />
          {busy === "run" ? "Starting" : "Test run"}
        </button>
        <button
          type="button"
          aria-label={`Delete ${routine.name}`}
          onClick={() => void guard("delete", async () => { await deleteRoutine(bot.id, routine.id); })}
          className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-background-primary-hover hover:text-text-primary"
        >
          <RiDeleteBinLine className="size-3.5" aria-hidden />
        </button>
      </div>
      {error && <p className="text-caption-1-regular text-text-error-primary">{error}</p>}
    </div>
  );
}

function NewRoutineForm({ bot, onCreated, onCancel }: { bot: ApiBot; onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cron, setCron] = useState<string>(CADENCES[2].cron);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (!name.trim() || !prompt.trim() || !cron.trim()) return setError("Name, cadence and instruction are all needed.");
    setBusy(true);
    setError(null);
    try {
      await createRoutine(bot.id, { name: name.trim(), prompt: prompt.trim(), cron: cron.trim(), timezone: browserTimezone() });
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the routine.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border-button-default p-3">
      <Input label="Name" placeholder="Weekly metrics" value={name} onChange={setName} />
      <label className="flex flex-col gap-1.5">
        <span className="text-body-2-medium text-text-primary">Instruction</span>
        <Textarea.Root
          value={prompt}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setPrompt(event.target.value)}
          rows={3}
          placeholder="Build the weekly metrics workbook and post the summary."
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-body-2-medium text-text-primary">When</span>
        <div className="flex flex-wrap gap-1.5">
          {CADENCES.map((option) => (
            <button
              key={option.cron}
              type="button"
              aria-pressed={cron === option.cron}
              onClick={() => setCron(option.cron)}
              className={cx(
                "rounded-full border px-3 py-1 text-caption-1-medium transition-colors",
                cron === option.cron
                  ? "border-border-button-hover bg-background-secondary-default text-text-primary"
                  : "border-border-button-default text-text-secondary hover:bg-background-primary-hover",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Input aria-label="Cron expression" placeholder="0 9 * * 1-5" value={cron} onChange={setCron} className="font-mono" />
      </div>
      {error && <p className="text-caption-1-regular text-text-error-primary">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="small" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="small" onClick={() => void submit()}>
          {busy ? "Creating" : "Add routine"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Routines: schedules owned by the bot that fire into its home thread. Active
 * toggle, Test run, last run - the reference's routine pane, on our
 * automations engine.
 */
export function RoutinesSection({ bot }: { bot: ApiBot }) {
  const router = useRouter();
  const [routines, setRoutines] = useState<ApiRoutine[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      setRoutines(await fetchRoutines(bot.id));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load routines.");
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-body-2-medium text-text-primary">Routines</h3>
        {!adding && (
          <Button variant="ghost" size="small" iconOnly leadingIcon={RiAddLine} aria-label="Add routine" onClick={() => setAdding(true)} />
        )}
      </div>
      {adding && (
        <NewRoutineForm
          bot={bot}
          onCancel={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void reload();
            router.refresh();
          }}
        />
      )}
      {routines === null && !error ? (
        <p className="text-caption-1-regular text-text-tertiary">Loading</p>
      ) : routines && routines.length === 0 && !adding ? (
        <p className="text-body-2-regular text-text-tertiary">No routines yet. Add one and {bot.name} runs it on schedule into this thread.</p>
      ) : (
        routines?.map((routine) => (
          <RoutineRow
            key={routine.id}
            bot={bot}
            routine={routine}
            onChange={() => {
              void reload();
              router.refresh();
            }}
          />
        ))
      )}
      {error && <p className="text-caption-1-regular text-text-error-primary">{error}</p>}
    </section>
  );
}
