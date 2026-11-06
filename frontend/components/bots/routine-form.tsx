"use client";

import { useEffect, useId, useRef, useState } from "react";
import { fetchSchedulePreview } from "@/app/agent/schedules/schedules-api";
import { cadenceLabel, isValidCron, nextRunLabelAt } from "@/app/agent/schedules/schedules-data";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import * as Textarea from "@/components/base/textarea/textarea";
import { cx } from "@/utils/cx";
import { createRoutine, updateRoutine } from "./routines-api";
import { type ApiBot, type ApiRoutine, OFFLINE_MESSAGE } from "./types";

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

type Field = "name" | "prompt" | "cron";

export function RoutineForm({ bot, routine, onSaved, onCancel }: { bot: ApiBot; routine?: ApiRoutine; onSaved: (saved: ApiRoutine) => void; onCancel: () => void }) {
  const promptErrorId = useId();
  const previewId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const cronRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [cron, setCron] = useState<string>(routine?.cron ?? CADENCES[2].cron);
  const [invalid, setInvalid] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timezone = routine ? routine.timezone : browserTimezone();
  /** The zone the preview runs in: a create that names none runs in UTC, as the server does. */
  const previewZone = timezone ?? "UTC";
  const [nextRunAt, setNextRunAt] = useState<string | null>(null);

  /** Live read of the cron field: the schedule in words and when it fires next. */
  const cronText = cron.trim();
  const cronValid = cronText.length > 0 && isValidCron(cronText);
  const words = cronValid && cadenceLabel(cronText) !== cronText ? cadenceLabel(cronText) : null;

  // The next run comes from the scheduler itself, debounced while typing;
  // a failed or empty answer shows no next run rather than a guessed one.
  useEffect(() => {
    if (!cronValid) {
      setNextRunAt(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchSchedulePreview(cronText, previewZone, controller.signal)
        .then((runs) => setNextRunAt(runs[0] ?? null))
        .catch(() => {
          if (!controller.signal.aborted) setNextRunAt(null);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [cronText, cronValid, previewZone]);

  const nextRun = nextRunLabelAt(nextRunAt, previewZone);
  const preview =
    cronText.length === 0
      ? null
      : !cronValid
        ? "That expression is invalid."
        : [words, nextRun ? `next run ${nextRun}` : null].filter(Boolean).join(" · ") || null;

  const clear = (field: Field) => setInvalid((current) => ({ ...current, [field]: undefined }));

  const submit = async () => {
    if (busy) return;
    const problems: Partial<Record<Field, string>> = {
      ...(name.trim() ? {} : { name: "Give the routine a name." }),
      ...(prompt.trim() ? {} : { prompt: "Say what it should do." }),
      ...(cron.trim() ? {} : { cron: "Pick a cadence or enter a cron expression." }),
    };
    if (Object.keys(problems).length > 0) {
      setInvalid(problems);
      (problems.name ? nameRef : problems.prompt ? promptRef : cronRef).current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = { name: name.trim(), prompt: prompt.trim(), cron: cron.trim(), timezone };
      const saved = routine ? await updateRoutine(bot.id, routine.id, input) : await createRoutine(bot.id, input);
      if (!saved) throw new Error("Unable to update the routine. Try again.");
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : OFFLINE_MESSAGE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border-button-default p-3">
      <Input
        ref={nameRef}
        label="Name"
        placeholder="Weekly metrics"
        value={name}
        onChange={(value) => {
          setName(value);
          clear("name");
        }}
        isInvalid={Boolean(invalid.name)}
        hint={invalid.name}
      />
      <label className="flex flex-col gap-1.5">
        <span className="text-body-2-medium text-text-primary">Instruction</span>
        <Textarea.Root
          ref={promptRef}
          value={prompt}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
            setPrompt(event.target.value);
            clear("prompt");
          }}
          rows={3}
          placeholder="Build the weekly metrics workbook and post the summary."
          hasError={Boolean(invalid.prompt)}
          aria-invalid={invalid.prompt ? true : undefined}
          aria-describedby={invalid.prompt ? promptErrorId : undefined}
        />
        {invalid.prompt && (
          <span id={promptErrorId} className="text-caption-1-medium text-text-error-primary">
            {invalid.prompt}
          </span>
        )}
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-body-2-medium text-text-primary">When</span>
        <div className="flex flex-wrap gap-1.5">
          {CADENCES.map((option) => (
            <button
              key={option.cron}
              type="button"
              aria-pressed={cron === option.cron}
              onClick={() => {
                setCron(option.cron);
                clear("cron");
              }}
              className={cx(
                "h-7 rounded-full border px-3 text-caption-1-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                cron === option.cron
                  ? "border-border-button-hover bg-background-secondary-default text-text-primary"
                  : "border-border-button-default text-text-secondary hover:bg-background-primary-hover",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Input
          ref={cronRef}
          label="Cron expression"
          placeholder="0 9 * * 1-5"
          value={cron}
          onChange={(value) => {
            setCron(value);
            clear("cron");
          }}
          isInvalid={Boolean(invalid.cron)}
          hint={invalid.cron ?? `Times in ${previewZone}.`}
          fieldClassName="font-mono"
          aria-describedby={preview ? previewId : undefined}
        />
        {preview && (
          <p
            id={previewId}
            aria-live="polite"
            className={cronValid ? "text-caption-1-regular text-text-tertiary" : "text-caption-1-regular text-text-error-primary"}
          >
            {preview}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-caption-1-regular text-text-error-primary">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" size="small" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="small" onClick={() => void submit()}>
          {routine ? (busy ? "Saving…" : "Save changes") : (busy ? "Creating…" : "Add routine")}
        </Button>
      </div>
    </div>
  );
}
