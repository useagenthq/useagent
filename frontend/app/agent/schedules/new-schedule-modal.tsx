"use client";

import { RiCalendarScheduleLine, RiErrorWarningLine, RiTimeZoneLine } from "@remixicon/react";
import { useEffect, useMemo, useState } from "react";
import { useEnabledEngines } from "@/components/chat/engine-picker";
import * as Button from "@/components/ui/button";
import * as Hint from "@/components/ui/hint";
import * as Input from "@/components/ui/input";
import * as Modal from "@/components/ui/modal";
import * as Select from "@/components/ui/select";
import * as Textarea from "@/components/ui/textarea";
import { cnExt } from "@/utils/cn";
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
          <div className="flex flex-col gap-1.5">
            <label htmlFor="automation-name" className="text-body-2-medium text-text-primary">
              What should run?
            </label>
            <Input.Root>
              <Input.Wrapper>
                <Input.Input
                  id="automation-name"
                  placeholder="Weekly dependency review"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Input.Wrapper>
            </Input.Root>
          </div>

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
            <Hint.Root>Include the repository, expected output, and success criteria.</Hint.Root>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-body-2-medium text-text-primary">Cadence</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CADENCE_PRESETS.map((preset) => (
                <button
                  key={preset.cron}
                  type="button"
                  onClick={() => setCron(preset.cron)}
                  className={cnExt(
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
            <div className="flex flex-col gap-1.5">
              <label htmlFor="automation-cron" className="text-body-2-medium text-text-primary">
                Cron expression
              </label>
              <Input.Root hasError={!cronValid && cron.trim().length > 0}>
                <Input.Wrapper>
                  <Input.Input
                    id="automation-cron"
                    className="font-mono"
                    value={cron}
                    onChange={(event) => setCron(event.target.value)}
                    spellCheck={false}
                  />
                </Input.Wrapper>
              </Input.Root>
              <Hint.Root hasError={!cronValid && cron.trim().length > 0}>
                {cronValid ? cadenceLabel(cron) : "Use five cron fields."}
              </Hint.Root>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="automation-timezone" className="text-body-2-medium text-text-primary">
                Timezone
              </label>
              <Input.Root>
                <Input.Wrapper>
                  <Input.Icon as={RiTimeZoneLine} />
                  <Input.Input
                    id="automation-timezone"
                    placeholder={schedule ? "Server timezone" : "Asia/Kolkata"}
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    spellCheck={false}
                  />
                </Input.Wrapper>
              </Input.Root>
              <Hint.Root>Use an IANA timezone such as Europe/London.</Hint.Root>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="automation-engine" className="text-body-2-medium text-text-primary">
              Agent
            </label>
            <Select.Root value={engine} onValueChange={setEngine}>
              <Select.Trigger id="automation-engine">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {engineOptions.map(({ id, label }) => (
                  <Select.Item key={id} value={id}>
                    {label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </div>

          {error && (
            <Hint.Root hasError>
              <Hint.Icon as={RiErrorWarningLine} />
              {error}
            </Hint.Root>
          )}
        </Modal.Body>

        <Modal.Footer>
          <p className="hidden text-caption-1-regular text-text-tertiary sm:block">
            {schedule ? "Changes apply to the next run." : "Created in paused state."}
          </p>
          <div className="ml-auto flex gap-2">
            <Button.Root variant="neutral" mode="stroke" size="small" onClick={onClose}>
              Cancel
            </Button.Root>
            <Button.Root
              variant="neutral"
              mode="filled"
              size="small"
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              {busy ? "Saving…" : schedule ? "Save changes" : "Create automation"}
            </Button.Root>
          </div>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
