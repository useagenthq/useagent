"use client";

import { useState } from "react";

import * as Button from "@/components/ui/button";
import * as Hint from "@/components/ui/hint";
import * as Input from "@/components/ui/input";
import * as Label from "@/components/ui/label";
import * as Modal from "@/components/ui/modal";
import * as Textarea from "@/components/ui/textarea";
import { createSkill } from "./skills-api";

/**
 * "New skill" — the header dark pill plus the AlignUI modal it opens, mirroring
 * the knowledge add-modal. Collects a name, description, comma-separated tags,
 * and three step-sections (one step per line) → POSTs to `/api/skills`, then
 * refetches via `onCreated`.
 */

type SaveStatus = "idle" | "saving" | "error";

function toLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function SectionTextarea({
  id,
  label,
  placeholder,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex w-full flex-col gap-1">
      <Label.Root htmlFor={id}>{label}</Label.Root>
      <Textarea.Root
        id={id}
        simple
        rows={3}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
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
        <Button.Root variant="neutral" mode="filled" className="rounded-full">
          New skill
        </Button.Root>
      </Modal.Trigger>

      <Modal.Content className="max-h-[90vh] max-w-[520px] overflow-y-auto">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex flex-col gap-1.5">
            <Modal.Title className="text-title-h6 text-text-strong-950">
              New skill
            </Modal.Title>
            <Modal.Description className="text-paragraph-sm text-text-sub-600">
              Capture a reusable skill Skynet can follow for repeatable work.
            </Modal.Description>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label.Root htmlFor="skill-name">Name</Label.Root>
              <Input.Root>
                <Input.Wrapper>
                  <Input.Input
                    id="skill-name"
                    placeholder="e.g. Ship a new page"
                    value={name}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Input.Wrapper>
              </Input.Root>
            </div>

            <div className="flex flex-col gap-1">
              <Label.Root htmlFor="skill-description">Description</Label.Root>
              <Input.Root>
                <Input.Wrapper>
                  <Input.Input
                    id="skill-description"
                    placeholder="When we need a new route that matches the shell…"
                    value={description}
                    disabled={busy}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </Input.Wrapper>
              </Input.Root>
              <Hint.Root>A one-line summary of when to use this skill.</Hint.Root>
            </div>

            <div className="flex flex-col gap-1">
              <Label.Root htmlFor="skill-tags">Tags</Label.Root>
              <Input.Root>
                <Input.Wrapper>
                  <Input.Input
                    id="skill-tags"
                    placeholder="frontend, alignui"
                    value={tags}
                    disabled={busy}
                    onChange={(event) => setTags(event.target.value)}
                  />
                </Input.Wrapper>
              </Input.Root>
              <Hint.Root>Comma-separated, e.g. frontend, review</Hint.Root>
            </div>

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
            <p className="rounded-xl bg-error-lighter px-3 py-2 text-paragraph-xs text-error-base">
              Couldn&rsquo;t reach Skynet. Check the backend and try again.
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            {busy && (
              <span className="agent-progress-loading-text mr-auto text-paragraph-sm">
                Saving…
              </span>
            )}
            <Button.Root className="rounded-full"
              variant="neutral"
              mode="stroke"
              onClick={() => {
                setOpen(false);
                reset();
              }}
              disabled={busy}
            >
              Cancel
            </Button.Root>
            <Button.Root className="rounded-full"
              onClick={onSave}
              disabled={busy || !name.trim() || !description.trim()}
            >
              Create skill
            </Button.Root>
          </div>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
