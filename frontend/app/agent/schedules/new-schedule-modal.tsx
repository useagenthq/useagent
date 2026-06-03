"use client";

import { RiCalendarScheduleLine, RiErrorWarningLine, RiTimeZoneLine } from "@remixicon/react";
import { useEffect, useMemo, useState } from "react";
import { useEnabledEngines } from "@/components/chat/engine-picker";
import { Button } from "@/components/base/buttons/button";
import { HintText } from "@/components/base/input/hint-text";
import { Input } from "@/components/base/input/input";
import * as Modal from "@/components/base/modal/modal";
import { Select, SelectItem } from "@/components/base/select/select";
import * as Textarea from "@/components/base/textarea/textarea";
import { cx } from "@/utils/cx";
import type { CreateScheduleInput } from "./schedules-api";
import {
  automationEditorEngineOptions,
  cadenceLabel,
  reconcileAutomationEngine,
  type ScheduleRecord,
} from "./schedules-data";

const CADENCE_PRESETS = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily", cron: "0 9 * * *" },
  { label: "Weekdays", cron: "0 9 * * 1-5" },
  { label: "Weekly", cron: "0 9 * * 1" },
] as const;

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function looksLikeCron(value: string): boolean {
  return value.trim().split(/\s+/).length === 5;
}

export function AutomationEditorModal({
  open,
  schedule,
  onClose,
  onSave,
}: {
  open: boolean;
  schedule: ScheduleRecord | null;
  onClose: () => void;
  onSave: (input: CreateScheduleInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cron, setCron] = useState<string>(CADENCE_PRESETS[2].cron);
  const [timezone, setTimezone] = useState(localZone);
  const enabledEngines = useEnabledEngines();
  const engineOptions = useMemo(
    () => automationEditorEngineOptions(enabledEngines, schedule?.engine),
    [enabledEngines, schedule?.engine],
  );
  const [engine, setEngine] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(schedule?.name ?? "");
    setPrompt(schedule?.prompt ?? "");
    setCron(schedule?.cron ?? CADENCE_PRESETS[2].cron);
    setTimezone(schedule ? (schedule.timezone ?? "") : localZone());
    setEngine(schedule?.engine ?? "");
    setBusy(false);
    setError(null);
  }, [open, schedule]);

  useEffect(() => {
    if (!open || schedule) return;
    setEngine((current) => reconcileAutomationEngine(engineOptions, current));
  }, [engineOptions, open, schedule]);

  const cronValid = looksLikeCron(cron);
  const canSubmit = Boolean(
    name.trim() && prompt.trim() && engine && cronValid && !busy,
  );

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        prompt: prompt.trim(),
        cron: cron.trim(),
        timezone: timezone.trim() || null,
        engine,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t save automation");
      setBusy(false);
    }
  };

  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content className="max-w-[620px]">
        <Modal.Header
          icon={RiCalendarScheduleLine}
          title={schedule ? "Edit automation" : "Create automation"}
          description={
            schedule
              ? "Update its instructions, agent, or cadence."
              : "Define recurring work. New automations start paused so you can review them first."
          }
        />

        <Modal.Body className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto">
          <Input
            label="What should run?"
            placeholder="Weekly dependency review"
            value={name}
            onChange={setName}
          />

          <div className="flex flex-col gap-1.5">
            <label htmlFor="automation-instructions" className="text-body-2-medium text-text-primary">
              Instructions
            </label>
            <Textarea.Root
              id="automation-instructions"
              simple
              rows={5}
              placeholder="Review dependency updates, run the relevant checks, and prepare a focused patch when an update is safe."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <HintText>Include the repository, expected output, and success criteria.</HintText>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-body-2-medium text-text-primary">Cadence</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CADENCE_PRESETS.map((preset) => (
                <button
                  key={preset.cron}
                  type="button"
                  onClick={() => setCron(preset.cron)}
                  className={cx(
                    "rounded-xl border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                    cron === preset.cron
                      ? "border-foreground-icon-primary bg-foreground-icon-primary text-background-full"
                      : "border-border-button-default bg-background-primary-default text-text-secondary hover:bg-background-secondary-default",
                  )}
                >
                  <span className="block text-body-2-medium">{preset.label}</span>
                  <span className="mt-0.5 block font-mono text-caption-1-medium opacity-70">{preset.cron}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Cron expression"
              inputClassName="font-mono"
              isInvalid={!cronValid && cron.trim().length > 0}
              value={cron}
              onChange={setCron}
              hint={cronValid ? cadenceLabel(cron) : "Use five cron fields."}
            />

            <Input
              label="Timezone"
              leadingIcon={RiTimeZoneLine}
              placeholder={schedule ? "Server timezone" : "Asia/Kolkata"}
              value={timezone}
              onChange={setTimezone}
              hint="Use an IANA timezone such as Europe/London."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-body-2-medium text-text-primary">Agent</label>
            <Select
              aria-label="Agent"
              selectedKey={engine || null}
              onSelectionChange={(key) => setEngine(String(key))}
            >
              {engineOptions.map(({ id, label }) => (
                <SelectItem key={id} id={id}>
                  {label}
                </SelectItem>
              ))}
            </Select>
          </div>

          {error && (
            <HintText isInvalid className="flex items-center gap-1">
              <RiErrorWarningLine className="size-4 shrink-0" aria-hidden />
              {error}
            </HintText>
          )}
        </Modal.Body>

        <Modal.Footer>
          <p className="hidden text-caption-1-regular text-text-tertiary sm:block">
            {schedule ? "Changes apply to the next run." : "Created in paused state."}
          </p>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" size="small" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="small"
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              {busy ? "Saving…" : schedule ? "Save changes" : "Create automation"}
            </Button>
          </div>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
