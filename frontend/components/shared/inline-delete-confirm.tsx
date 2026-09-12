"use client";

import { Button } from "@/components/base/buttons/button";

/**
 * The in-row "are you sure" strip a list row shows before a destructive action:
 * one question, one line of consequence, Cancel and Delete. Shared by every
 * row-level delete so the product asks the same way everywhere.
 */
export function InlineDeleteConfirm({
  question,
  consequence,
  busy = false,
  onCancel,
  onConfirm,
}: {
  question: string;
  consequence: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      data-testid="inline-delete-confirm"
      className="flex flex-col gap-3 border-t border-border-button-default bg-background-tertiary-error px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
    >
      <div>
        <p className="text-body-2-medium text-text-primary">{question}</p>
        <p className="mt-0.5 text-caption-1-regular text-text-secondary">{consequence}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="secondary" size="small" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" size="small" disabled={busy} onClick={onConfirm}>
          Delete
        </Button>
      </div>
    </div>
  );
}
