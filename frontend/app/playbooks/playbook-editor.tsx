"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import * as Modal from "@/components/ui/modal";
import { createSkill, updateSkill } from "@/app/skills/skills-api";
import type { Skill } from "@/app/skills/skills-data";
import { SectionTextarea } from "@/components/foundations/form-recipes";

/**
 * Create/edit a playbook. A playbook is a plain skill with `kind: "playbook"`
 * whose content is a structured Overview / Procedure / Verify document. Creating
 * POSTs kind:"playbook"; editing PATCHes - and a content change mints a new
 * immutable version server-side, so a past run stays pinned to the version it
 * ran. A controlled modal (open/onOpenChange owned by the parent) so both the
 * page's "New playbook" button and the detail view's "Edit" reuse it. The Modal
 * shell stays AlignUI (no BoardUI equivalent); fields are BoardUI primitives.
 */

type SaveStatus = "idle" | "saving" | "error";

function toLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Plain textarea styled to match the BoardUI input field shell (mirrors the
 *  skills new-skill-modal - no shared BoardUI textarea primitive yet). */
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
      <Modal.Content className="max-h-[90vh] max-w-[520px] overflow-y-auto rounded-3xl border border-border-button-default bg-background-primary-default shadow-dropdown">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex flex-col gap-1.5">
            <Modal.Title className="text-title-3-medium text-text-primary">
              {isEdit ? "Edit playbook" : "New playbook"}
            </Modal.Title>
            <Modal.Description className="text-body-2-regular text-text-secondary">
              {isEdit
                ? "Saving a content change mints a new version. Past runs stay pinned to the version they used."
                : "A structured procedure useAgent follows as guidance - an Overview, numbered Procedure steps, and a Verify checklist."}
            </Modal.Description>
          </div>

          <div className="flex flex-col gap-4">
            <Input
              label="Name"
              placeholder="e.g. Triage a customer escalation"
              value={name}
              isDisabled={busy}
              onChange={setName}
            />

            <Input
              label="Description"
              placeholder="When to reach for this procedure..."
              hint="A one-line summary of when to follow this playbook."
              value={description}
              isDisabled={busy}
              onChange={setDescription}
            />

            <Input
              label="Tags"
              placeholder="support, escalation"
              hint="Comma-separated, e.g. support, review"
              value={tags}
              isDisabled={busy}
              onChange={setTags}
            />

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
            <p className="rounded-xl bg-background-tertiary-error px-3 py-2 text-caption-1-regular text-text-error-primary">
              Couldn&rsquo;t save. Check the backend and try again.
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
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={onSave}
              disabled={busy || !name.trim() || !description.trim()}
            >
              {isEdit ? "Save version" : "Create playbook"}
            </Button>
          </div>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
