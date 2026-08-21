"use client";

import { useState } from "react";

import * as Button from "@/components/ui/button";
import * as Hint from "@/components/ui/hint";
import * as Input from "@/components/ui/input";
import * as Label from "@/components/ui/label";
import * as Modal from "@/components/ui/modal";
import * as Select from "@/components/ui/select";
import * as Textarea from "@/components/ui/textarea";
import { ingestKnowledge } from "./knowledge-api";
import { knowledgeFolderLabel } from "./knowledge-data";

/**
 * "Add knowledge" — the header dark pill plus the AlignUI modal it opens. The
 * modal collects the four Knowledge fields: name, a trigger sentence, the body
 * content, and the folder scope.
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
        {/* Header pill — AlignUI neutral filled button, rounded to a pill. */}
        <Button.Root variant="neutral" mode="filled" className="rounded-full">
          Add knowledge
        </Button.Root>
      </Modal.Trigger>

      <Modal.Content className="max-w-[480px]">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex flex-col gap-1.5">
            <Modal.Title className="text-title-h6 text-text-strong-950">
              Add knowledge
            </Modal.Title>
            <Modal.Description className="text-paragraph-sm text-text-sub-600">
              Teach useAgent a fact or convention it should remember across every
              run.
            </Modal.Description>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label.Root htmlFor="knowledge-name">Name</Label.Root>
              <Input.Root>
                <Input.Wrapper>
                  <Input.Input
                    id="knowledge-name"
                    placeholder="e.g. Prefer semantic tokens"
                    value={name}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Input.Wrapper>
              </Input.Root>
            </div>

            <div className="flex flex-col gap-1">
              <Label.Root htmlFor="knowledge-trigger">Trigger</Label.Root>
              <Input.Root>
                <Input.Wrapper>
                  <Input.Input
                    id="knowledge-trigger"
                    placeholder="When working with AlignUI components…"
                    value={trigger}
                    disabled={busy}
                    onChange={(event) => setTrigger(event.target.value)}
                  />
                </Input.Wrapper>
              </Input.Root>
              <Hint.Root>A phrase that tells useAgent when to recall this.</Hint.Root>
            </div>

            <div className="flex flex-col gap-1">
              <Label.Root htmlFor="knowledge-content">Content</Label.Root>
              <Textarea.Root
                id="knowledge-content"
                simple
                rows={4}
                placeholder="What should useAgent know?"
                value={body}
                disabled={busy}
                onChange={(event) => setBody(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label.Root>Folder</Label.Root>
              <Select.Root
                value={folder}
                onValueChange={setFolder}
                disabled={busy}
              >
                <Select.Trigger>
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {folders.map((option) => (
                    <Select.Item key={option} value={option}>
                      {knowledgeFolderLabel(option)}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </div>
          </div>

          {/* Worth-saving gate + error surfacing */}
          {status === "dropped" && (
            <p className="rounded-xl bg-bg-weak-50 px-3 py-2 text-paragraph-xs text-text-sub-600">
              useAgent judged this not worth saving. Try adding more specific
              detail, or close to discard.
            </p>
          )}
          {status === "deferred" && (
            <p className="rounded-xl bg-warning-lighter px-3 py-2 text-paragraph-xs text-warning-dark">
              Distillation is unavailable right now, so this wasn&rsquo;t saved
              yet. Your text is still here; press Save to retry once the model
              is reachable.
            </p>
          )}
          {status === "error" && (
            <p className="rounded-xl bg-error-lighter px-3 py-2 text-paragraph-xs text-error-base">
              Couldn&rsquo;t reach useAgent. Check the backend and try again.
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            {busy && (
              <span className="agent-progress-loading-text mr-auto text-paragraph-sm">
                Distilling…
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
              disabled={busy || !name.trim() || !body.trim()}
            >
              Save
            </Button.Root>
          </div>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
