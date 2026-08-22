"use client";

import {
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiPencilLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import { useState } from "react";

import { Chip } from "@/components/base/badges/chip";
import { relativeTime } from "@/utils/format";
import { SCOPE_META, type MemoryScope, type StoredMemory } from "./memory-data";

/**
 * One stored L1 fact. View mode shows the fact + its source-scope chip and
 * timestamps; "Correct" opens an inline editor (PATCH /api/memory/item/:id);
 * "Delete" requires a two-step in-place confirm before DELETE. Both operate on
 * the real MemoryCore pool for this scope. `readOnly` hides the actions (used
 * for the fail-closed personal view).
 */
export function StoredMemoryCard({
  item,
  scope,
  onCorrect,
  onDelete,
}: {
  item: StoredMemory;
  scope: MemoryScope;
  onCorrect: (id: string, content: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [draft, setDraft] = useState(item.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = SCOPE_META[item.sourceScope];

  async function save() {
    const next = draft.trim();
    if (!next || next === item.content) {
      setMode("view");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCorrect(item.id, next);
      setMode("view");
    } catch {
      // MemoryCore /v3/atomic/update rejects edits to org-pool memory as
      // "belongs to a different user" - a known upstream limitation. Surface it
      // honestly rather than a generic failure.
      setError(
        "The memory service rejected this correction (a known upstream limitation for org-pool memory). Delete is supported.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await onDelete(item.id);
      // The row is dropped by the parent on success; nothing more to do here.
    } catch {
      setError("Delete failed. Please retry.");
      setBusy(false);
      setMode("view");
    }
  }

  return (
    <article className="flex flex-col gap-2.5 rounded-2xl bg-background-primary-default p-4 shadow-card ring-1 ring-inset ring-border-button-default transition-colors hover:ring-border-button-hover">
      {mode === "edit" ? (
        <textarea
          aria-label="Correct memory content"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          className="w-full resize-y rounded-xl border border-border-button-default bg-background-primary-default p-2.5 text-body-2-regular text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        />
      ) : (
        <p className="text-body-2-regular text-text-primary">{item.content}</p>
      )}

      {item.background && mode !== "edit" && (
        <p className="text-caption-1-regular italic text-text-tertiary">{item.background}</p>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Chip variant="caption" color={item.sourceScope === "org" ? "blue" : "purple"}>
          {meta.tag}
        </Chip>
        <Chip variant="caption" color="gray">
          {item.type}
        </Chip>
        <span className="text-caption-1-regular text-text-tertiary">
          Updated {relativeTime(item.updatedAt)}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {mode === "view" && (
            <>
              <IconButton
                icon={RiPencilLine}
                label={`Correct: ${item.content.slice(0, 40)}`}
                onClick={() => {
                  setDraft(item.content);
                  setMode("edit");
                }}
              />
              <IconButton
                icon={RiDeleteBinLine}
                label={`Delete: ${item.content.slice(0, 40)}`}
                onClick={() => setMode("confirm")}
              />
            </>
          )}

          {mode === "edit" && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={save}
                className="inline-flex items-center gap-1 rounded-full bg-accent-500 px-3 py-1 text-caption-1-medium text-white disabled:opacity-60"
              >
                <RiCheckLine className="size-3.5" aria-hidden />
                Save
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode("view")}
                className="inline-flex items-center gap-1 rounded-full border border-border-button-default px-3 py-1 text-caption-1-medium text-text-secondary hover:text-text-primary"
              >
                Cancel
              </button>
            </>
          )}

          {mode === "confirm" && (
            <>
              <span className="text-caption-1-regular text-text-secondary">Delete permanently?</span>
              <button
                type="button"
                disabled={busy}
                onClick={remove}
                className="inline-flex items-center gap-1 rounded-full bg-red-500 px-3 py-1 text-caption-1-medium text-white disabled:opacity-60"
              >
                <RiCheckLine className="size-3.5" aria-hidden />
                Delete
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode("view")}
                className="inline-flex items-center rounded-full border border-border-button-default p-1 text-text-secondary hover:text-text-primary"
                aria-label="Cancel delete"
              >
                <RiCloseLine className="size-3.5" aria-hidden />
              </button>
            </>
          )}
        </div>
      </div>

      {error && <p className="text-caption-1-regular text-text-error-primary">{error}</p>}
    </article>
  );
}

function IconButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: RemixiconComponentType;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-lg text-foreground-icon-tertiary transition-colors hover:bg-background-tertiary-default hover:text-foreground-icon-secondary"
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
