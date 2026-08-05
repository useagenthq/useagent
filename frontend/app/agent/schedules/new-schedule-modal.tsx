"use client";

import { RiErrorWarningLine } from "@remixicon/react";
import { useState } from "react";
import * as Button from "@/components/ui/button";
import * as Hint from "@/components/ui/hint";
import * as Input from "@/components/ui/input";
import * as Modal from "@/components/ui/modal";
import * as Select from "@/components/ui/select";
import * as Textarea from "@/components/ui/textarea";
import type { CreateScheduleInput } from "./schedules-api";
import { engineLabel, SCHEDULE_ENGINES } from "./schedules-data";

/**
 * "New schedule" modal — a real create form (name / cron / prompt / engine),
 * wired to `POST /api/schedules`. New schedules are created DISABLED (reference bot's
 * safety default) so nothing auto-fires until it's toggled on in the list.
 *
 * `onCreate` performs the network call and rejects on failure; the modal stays
 * open and surfaces the backend error (e.g. an invalid cron expression).
 */

const DEFAULT_CRON = "0 9 * * 1"; // Mondays 09:00

/** Loose client check — the backend does the authoritative 5-field validation. */
function looksLikeCron(value: string): boolean {
  return value.trim().split(/\s+/).length === 5;
}

export function NewScheduleModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: CreateScheduleInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [cron, setCron] = useState(DEFAULT_CRON);
  const [prompt, setPrompt] = useState("");
  const [engine, setEngine] = useState<string>(SCHEDULE_ENGINES[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cronValid = looksLikeCron(cron);
  const canSubmit =
    name.trim().length > 0 && prompt.trim().length > 0 && cronValid && !busy;

  const reset = () => {
    setName("");
    setCron(DEFAULT_CRON);
    setPrompt("");
    setEngine(SCHEDULE_ENGINES[0]);
    setError(null);
    setBusy(false);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        cron: cron.trim(),
        prompt: prompt.trim(),
        engine,
      });
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create schedule");
      setBusy(false);
    }
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <Modal.Content className="max-w-[520px]">
        <Modal.Header
          title="New schedule"
          description="Describe the work and the cron cadence Skynet should start it on. Created off — enable it from the list."
        />

        <Modal.Body className="flex flex-col gap-4">
          <div className="flex w-full flex-col gap-1">
            <span className="text-label-sm text-text-strong-950">Name</span>
            <Input.Root>
              <Input.Wrapper>
                <Input.Input
                  aria-label="Name"
                  placeholder="e.g. Nightly dependency audit"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Input.Wrapper>
            </Input.Root>
          </div>

          <div className="flex w-full flex-col gap-1">
            <span className="text-label-sm text-text-strong-950">Cron</span>
            <Input.Root hasError={!cronValid && cron.trim().length > 0}>
              <Input.Wrapper>
                <Input.Input
                  aria-label="Cron expression"
                  className="font-mono"
                  placeholder="0 9 * * 1"
                  value={cron}
                  onChange={(event) => setCron(event.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </Input.Wrapper>
            </Input.Root>
            <Hint.Root hasError={!cronValid && cron.trim().length > 0}>
              5 fields: minute hour day month weekday — e.g. “0 9 * * 1” is
              Mondays 09:00.
            </Hint.Root>
          </div>

          <div className="flex w-full flex-col gap-1">
            <span className="text-label-sm text-text-strong-950">Prompt</span>
            <Textarea.Root
              simple
              aria-label="Prompt"
              rows={3}
              placeholder="e.g. Audit dependencies for CVEs and open a PR with safe bumps"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>

          <div className="flex w-full flex-col gap-1">
            <span className="text-label-sm text-text-strong-950">Engine</span>
            <Select.Root value={engine} onValueChange={setEngine}>
              <Select.Trigger aria-label="Engine">
                <Select.Value placeholder="Select an engine" />
              </Select.Trigger>
              <Select.Content>
                {SCHEDULE_ENGINES.map((id) => (
                  <Select.Item key={id} value={id}>
                    {engineLabel(id)}
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
          <Button.Root
            className="rounded-full"
            variant="neutral"
            mode="stroke"
            size="small"
            onClick={onClose}
          >
            Cancel
          </Button.Root>
          <Button.Root
            className="rounded-full"
            variant="neutral"
            mode="filled"
            size="small"
            onClick={submit}
            disabled={!canSubmit}
          >
            {busy ? "Creating…" : "Create"}
          </Button.Root>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
