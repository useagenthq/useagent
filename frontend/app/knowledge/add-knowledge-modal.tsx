"use client";

import { useState } from "react";

import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Label } from "@/components/base/input/label";
import { Select, SelectItem } from "@/components/base/select/select";
import * as Modal from "@/components/ui/modal";
import { ingestKnowledge } from "./knowledge-api";
import { knowledgeFolderLabel } from "./knowledge-data";
import { TEXTAREA_FIELD } from "@/components/foundations/form-recipes";

/**
 * "Add knowledge" — the header CTA plus the modal it opens. The modal collects
 * the four Knowledge fields: name, a trigger sentence, the body content, and
 * the folder scope. The Modal shell stays AlignUI (no BoardUI equivalent); its
 * visible surfaces are BoardUI base primitives, mirroring the skills modal.
 *
 * On Save it composes the fields into distillation text and POSTs to
 * `/api/knowledge/ingest`, showing a "Distilling…" state until the backend
 * responds. Every non-storing outcome is surfaced honestly instead of faking a
 * save: `dropped` (worth_saving gate) and `deferred` (distillation unavailable,
 * so the backend stored NOTHING) each show a subtle notice and keep the modal
 * open so the user can adjust or retry; only a `stored`/`skipped` response
 * refetches the list (via `onIngested`) and closes.
 */

type SaveStatus = "idle" | "distilling" | "dropped" | "deferred" | "error";

export function AddKnowledgeModal({
  folders,
  onIngested,
}: {
  folders: string[];
  onIngested: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("");
  const [body, setBody] = useState("");
  const [folder, setFolder] = useState<string>(folders[0] ?? "Global");
  const [status, setStatus] = useState<SaveStatus>("idle");

  const busy = status === "distilling";

  const reset = () => {
    setName("");
    setTrigger("");
    setBody("");
    setFolder(folders[0] ?? "Global");
    setStatus("idle");
  };

  const onSave = async () => {
    setStatus("distilling");
    try {
      const result = await ingestKnowledge({
        name: name.trim(),
        trigger: trigger.trim(),
        content: body.trim(),
        folder,
      });
      // Non-storing outcomes: nothing was written, so DON'T refetch or close —
      // surface the honest reason and let the user adjust (dropped) or retry
      // (deferred: distillation unavailable, id is null).
      if (result.status === "dropped" || result.status === "deferred") {
        setStatus(result.status);
        return;
      }
      await onIngested();
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
        <Button variant="primary">Add knowledge</Button>
      </Modal.Trigger>

      <Modal.Content className="max-h-[90vh] max-w-[480px] overflow-y-auto rounded-3xl border border-border-button-default bg-background-primary-default shadow-dropdown">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex flex-col gap-1.5">
            <Modal.Title className="text-title-3-medium text-text-primary">
              Add knowledge
            </Modal.Title>
            <Modal.Description className="text-body-2-regular text-text-secondary">
              Teach useAgent a fact or convention it should remember across every
              run.
            </Modal.Description>
          </div>

          <div className="flex flex-col gap-4">
            <Input
              label="Name"
              placeholder="e.g. Prefer semantic tokens"
              value={name}
              isDisabled={busy}
              onChange={setName}
            />

            <Input
              label="Trigger"
              placeholder="When working with AlignUI components…"
              hint="A phrase that tells useAgent when to recall this."
              value={trigger}
              isDisabled={busy}
              onChange={setTrigger}
            />

            <div className="flex w-full flex-col gap-1">
              <Label htmlFor="knowledge-content">Content</Label>
              <textarea
                id="knowledge-content"
                rows={4}
                placeholder="What should useAgent know?"
                value={body}
                disabled={busy}
                onChange={(event) => setBody(event.target.value)}
                className={TEXTAREA_FIELD}
              />
            </div>

            <div className="flex w-full flex-col gap-1">
              <Label>Folder</Label>
              <Select
                aria-label="Folder"
                selectedKey={folder}
                onSelectionChange={(key) => {
                  if (typeof key === "string") setFolder(key);
                }}
                isDisabled={busy}
              >
                {folders.map((option) => (
                  <SelectItem key={option} id={option}>
                    {knowledgeFolderLabel(option)}
                  </SelectItem>
                ))}
              </Select>
            </div>
          </div>

          {/* Worth-saving gate + error surfacing */}
          {status === "dropped" && (
            <p className="rounded-xl bg-background-secondary-default px-3 py-2 text-caption-1-regular text-text-secondary">
              useAgent judged this not worth saving. Try adding more specific
              detail, or close to discard.
            </p>
          )}
          {status === "deferred" && (
            <p className="rounded-xl bg-status-yellow-background px-3 py-2 text-caption-1-regular text-status-yellow-text">
              Distillation is unavailable right now, so this wasn&rsquo;t saved
              yet. Your text is still here; press Save to retry once the model
              is reachable.
            </p>
          )}
          {status === "error" && (
            <p className="rounded-xl bg-background-tertiary-error px-3 py-2 text-caption-1-regular text-text-error-primary">
              Couldn&rsquo;t reach useAgent. Check the backend and try again.
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            {busy && (
              <span className="agent-progress-loading-text mr-auto text-body-2-regular">
                Distilling…
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
              disabled={busy || !name.trim() || !body.trim()}
            >
              Save
            </Button>
          </div>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
