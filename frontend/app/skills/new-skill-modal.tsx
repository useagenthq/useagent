"use client";

import { useState } from "react";

import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import * as Modal from "@/components/base/modal/modal";
import { createSkill } from "./skills-api";
import { SectionTextarea } from "@/components/foundations/form-recipes";

/**
 * "New skill" — the header CTA plus the modal it opens, mirroring the knowledge
 * add-modal. Collects a name, description, comma-separated tags, and three
 * step-sections (one step per line) → POSTs to `/api/skills`, then refetches
 * via `onCreated`. The Modal shell stays vendored (no BoardUI equivalent); its
 * visible surfaces are restyled with BoardUI tokens.
 */

type SaveStatus = "idle" | "saving" | "error";

function toLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function NewSkillModal({
  onCreated,
}: {
  onCreated: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [overview, setOverview] = useState("");
  const [procedure, setProcedure] = useState("");
  const [verify, setVerify] = useState("");
  const [status, setStatus] = useState<SaveStatus>("idle");

  const busy = status === "saving";

  const reset = () => {
    setName("");
    setDescription("");
    setTags("");
    setOverview("");
    setProcedure("");
    setVerify("");
    setStatus("idle");
  };

  const onSave = async () => {
    setStatus("saving");
    try {
      await createSkill({
        name: name.trim(),
        description: description.trim(),
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        sections: {
          overview: toLines(overview),
          procedure: toLines(procedure),
          verify: toLines(verify),
        },
      });
      await onCreated();
      reset();
      setOpen(false);
    } catch {
      setStatus("error");
    }
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Modal.Trigger asChild>
        <Button variant="primary">New skill</Button>
      </Modal.Trigger>

      <Modal.Content className="max-h-[90vh] max-w-[520px] overflow-y-auto rounded-3xl border border-border-button-default bg-background-primary-default shadow-dropdown">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex flex-col gap-1.5">
            <Modal.Title className="text-title-3-medium text-text-primary">
              New skill
            </Modal.Title>
            <Modal.Description className="text-body-2-regular text-text-secondary">
              Capture a reusable skill useAgent can follow for repeatable work.
            </Modal.Description>
          </div>

          <div className="flex flex-col gap-4">
            <Input
              label="Name"
              placeholder="e.g. Ship a new page"
              value={name}
              isDisabled={busy}
              onChange={setName}
            />

            <Input
              label="Description"
              placeholder="When we need a new route that matches the shell…"
              hint="A one-line summary of when to use this skill."
              value={description}
              isDisabled={busy}
              onChange={setDescription}
            />

            <Input
              label="Tags"
              placeholder="frontend, alignui"
              hint="Comma-separated, e.g. frontend, review"
              value={tags}
              isDisabled={busy}
              onChange={setTags}
            />

            <SectionTextarea
              id="skill-overview"
              label="Overview"
              placeholder="One step per line…"
              value={overview}
              onChange={setOverview}
              disabled={busy}
            />
            <SectionTextarea
              id="skill-procedure"
              label="Procedure"
              placeholder="One step per line…"
              value={procedure}
              onChange={setProcedure}
              disabled={busy}
            />
            <SectionTextarea
              id="skill-verify"
              label="Verify"
              placeholder="One step per line…"
              value={verify}
              onChange={setVerify}
              disabled={busy}
            />
          </div>

          {status === "error" && (
            <p className="rounded-xl bg-background-tertiary-error px-3 py-2 text-caption-1-regular text-text-error-primary">
              Couldn&rsquo;t reach useAgent. Check the backend and try again.
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            {busy && (
              <span className="agent-progress-loading-text mr-auto text-body-2-regular">
                Saving…
              </span>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
                reset();
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={onSave}
              disabled={busy || !name.trim() || !description.trim()}
            >
              Create skill
            </Button>
          </div>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
