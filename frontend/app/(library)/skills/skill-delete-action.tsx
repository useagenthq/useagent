"use client";

import { useState } from "react";
import { RiDeleteBinLine } from "@remixicon/react";

import { Button } from "@/components/base/buttons/button";
import { InlineDeleteConfirm } from "@/components/shared/inline-delete-confirm";
import { deleteSkill } from "./skills-api";

/**
 * The whole delete flow for one skill or playbook (both are skills, one DELETE
 * endpoint): a Delete button that opens the shared confirm strip, the backend
 * call, and a plain error line if it fails. On success the caller refreshes its
 * list (and closes the dialog) via `onDeleted`. Reused by the skill detail
 * dialog and the playbook detail so delete asks and behaves the same in both.
 */
export function SkillDeleteAction({
  skillId,
  question,
  consequence,
  onDeleted,
}: {
  skillId: string;
  question: string;
  consequence: string;
  /** Deleted for good - the caller refetches its list and closes if needed. */
  onDeleted: () => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteSkill(skillId);
      setConfirming(false);
      await onDeleted();
    } catch {
      setError("Delete failed. Check the backend and try again.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="secondary"
        size="small"
        leadingIcon={RiDeleteBinLine}
        disabled={deleting}
        onClick={() => setConfirming(true)}
        className="self-start"
      >
        Delete
      </Button>
      {confirming && (
        <>
          <InlineDeleteConfirm
            question={question}
            consequence={consequence}
            busy={deleting}
            onCancel={() => setConfirming(false)}
            onConfirm={onConfirm}
          />
          {error && (
            <p role="alert" className="text-caption-1-regular text-text-error-primary">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
