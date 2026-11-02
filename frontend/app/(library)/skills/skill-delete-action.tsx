"use client";

import { useState } from "react";
import { RiDeleteBinLine } from "@remixicon/react";

import { Button } from "@/components/base/buttons/button";
import { InlineDeleteConfirm } from "@/components/shared/inline-delete-confirm";
import { deleteSkill, type SkillHolder } from "./skills-api";

const NAMES = new Intl.ListFormat("en", { type: "conjunction" });

/** Why a delete was refused, in plain words: who still uses it and what to do. */
function inUseMessage(holders: readonly SkillHolder[], total: number): string {
  const names = holders.map((holder) =>
    holder.bot ? `${holder.name} (${holder.bot}'s routine)` : holder.name,
  );
  const more = total - names.length;
  const list = NAMES.format(more > 0 ? [...names, `${more} more`] : names);
  return total === 1
    ? `${list} still uses this. Pause it or change what it uses, then delete.`
    : `${list} still use this. Pause them or change what they use, then delete.`;
}

/**
 * The whole delete flow for one skill or playbook (both are skills, one DELETE
 * endpoint): a Delete button that opens the shared confirm strip, the backend
 * call, and a plain line in the strip when it does not go through. On success
 * (or when a teammate already deleted it) the caller refreshes its list (and
 * closes the dialog) via `onDeleted`. Reused by the skill detail dialog and the
 * playbook detail so delete asks and behaves the same in both.
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
  const [problem, setProblem] = useState<string | null>(null);

  const onConfirm = async () => {
    setDeleting(true);
    setProblem(null);
    try {
      const outcome = await deleteSkill(skillId);
      if (outcome.kind === "in-use") {
        setProblem(inUseMessage(outcome.holders, outcome.total));
        return;
      }
      setConfirming(false);
      await onDeleted();
    } catch {
      setProblem("Couldn't delete this right now. Try again in a moment.");
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
        onClick={() => {
          setProblem(null);
          setConfirming(true);
        }}
        className="self-start"
      >
        Delete
      </Button>
      {confirming && (
        <InlineDeleteConfirm
          question={question}
          consequence={consequence}
          problem={problem}
          busy={deleting}
          onCancel={() => setConfirming(false)}
          onConfirm={onConfirm}
        />
      )}
    </div>
  );
}
