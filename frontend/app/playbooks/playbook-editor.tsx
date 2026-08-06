"use client";

import { useEffect, useState } from "react";

import * as Button from "@/components/ui/button";
import * as Hint from "@/components/ui/hint";
import * as Input from "@/components/ui/input";
import * as Label from "@/components/ui/label";
import * as Modal from "@/components/ui/modal";
import * as Textarea from "@/components/ui/textarea";
import { createSkill, updateSkill } from "@/app/skills/skills-api";
import type { Skill } from "@/app/skills/skills-data";

/**
 * Create/edit a playbook. A playbook is a plain skill with `kind: "playbook"`
 * whose content is a structured Overview / Procedure / Verify document. Creating
 * POSTs kind:"playbook"; editing PATCHes - and a content change mints a new
 * immutable version server-side, so a past run stays pinned to the version it
 * ran. A controlled modal (open/onOpenChange owned by the parent) so both the
 * page's "New playbook" button and the detail view's "Edit" reuse it.
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

export function PlaybookEditor({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The playbook being edited, or null to create a new one. */
  editing: Skill | null;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [overview, setOverview] = useState("");
  const [procedure, setProcedure] = useState("");
  const [verify, setVerify] = useState("");
  const [status, setStatus] = useState<SaveStatus>("idle");

  const busy = status === "saving";
  const isEdit = editing !== null;

  // Prefill from the edited playbook each time the modal opens (or reset for a
  // fresh create). Depends on `open` so reopening always starts from the source.
  useEffect(() => {
    if (!open) return;
    setStatus("idle");
    setName(editing?.name ?? "");
    setDescription(editing?.description ?? "");
    setTags(editing?.tags.join(", ") ?? "");
    setOverview(editing?.sections.overview.join("\n") ?? "");
    setProcedure(editing?.sections.procedure.join("\n") ?? "");
    setVerify(editing?.sections.verify.join("\n") ?? "");
  }, [open, editing]);

  const onSave = async () => {
    setStatus("saving");
    const payload = {
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
    };
    try {
      if (editing) {
        await updateSkill(editing.id, payload);
      } else {
        await createSkill({ ...payload, kind: "playbook" });
      }
      await onSaved();
      onOpenChange(false);
    } catch {
      setStatus("error");
    }
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      <Modal.Content className="max-h-[90vh] max-w-[520px] overflow-y-auto">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex flex-col gap-1.5">
            <Modal.Title className="text-title-h6 text-text-strong-950">
              {isEdit ? "Edit playbook" : "New playbook"}
            </Modal.Title>
            <Modal.Description className="text-paragraph-sm text-text-sub-600">
              {isEdit
                ? "Saving a content change mints a new version. Past runs stay pinned to the version they used."
                : "A structured procedure Skynet follows as guidance - an Overview, numbered Procedure steps, and a Verify checklist."}
            </Modal.Description>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label.Root htmlFor="playbook-name">Name</Label.Root>
              <Input.Root>
                <Input.Wrapper>
                  <Input.Input
                    id="playbook-name"
                    placeholder="e.g. Triage a customer escalation"
                    value={name}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Input.Wrapper>
              </Input.Root>
            </div>

            <div className="flex flex-col gap-1">
              <Label.Root htmlFor="playbook-description">Description</Label.Root>
              <Input.Root>
                <Input.Wrapper>
                  <Input.Input
                    id="playbook-description"
                    placeholder="When to reach for this procedure..."
                    value={description}
                    disabled={busy}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </Input.Wrapper>
              </Input.Root>
              <Hint.Root>A one-line summary of when to follow this playbook.</Hint.Root>
            </div>

            <div className="flex flex-col gap-1">
              <Label.Root htmlFor="playbook-tags">Tags</Label.Root>
              <Input.Root>
                <Input.Wrapper>
                  <Input.Input
                    id="playbook-tags"
                    placeholder="support, escalation"
                    value={tags}
                    disabled={busy}
                    onChange={(event) => setTags(event.target.value)}
                  />
                </Input.Wrapper>
              </Input.Root>
              <Hint.Root>Comma-separated, e.g. support, review</Hint.Root>
            </div>

            <SectionTextarea
              id="playbook-overview"
              label="Overview"
              placeholder="What this playbook is for - one line per point..."
              value={overview}
              onChange={setOverview}
              disabled={busy}
            />
            <SectionTextarea
              id="playbook-procedure"
              label="Procedure"
              placeholder="One step per line (rendered as a numbered list)..."
              value={procedure}
              onChange={setProcedure}
              disabled={busy}
            />
            <SectionTextarea
              id="playbook-verify"
              label="Verify"
              placeholder="One check per line the agent confirms before finishing..."
              value={verify}
              onChange={setVerify}
              disabled={busy}
            />
          </div>

          {status === "error" && (
            <p className="rounded-xl bg-error-lighter px-3 py-2 text-paragraph-xs text-error-base">
              Couldn&rsquo;t save. Check the backend and try again.
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            {busy && (
              <span className="agent-progress-loading-text mr-auto text-paragraph-sm">
                Saving…
              </span>
            )}
            <Button.Root
              className="rounded-full"
              variant="neutral"
              mode="stroke"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button.Root>
            <Button.Root
              className="rounded-full"
              onClick={onSave}
              disabled={busy || !name.trim() || !description.trim()}
            >
              {isEdit ? "Save version" : "Create playbook"}
            </Button.Root>
          </div>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
