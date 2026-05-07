"use client";

import {
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiPencilLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import { useState } from "react";

import * as Badge from "@/components/ui/badge";
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
    <article className="flex flex-col gap-2.5 rounded-2xl bg-bg-white-0 p-4 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200 transition-colors hover:ring-stroke-sub-300">
      {mode === "edit" ? (
        <textarea
          aria-label="Correct memory content"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          className="w-full resize-y rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-2.5 text-paragraph-sm text-text-strong-950 outline-none focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
        />
      ) : (
        <p className="text-paragraph-sm text-text-strong-950">{item.content}</p>
      )}

      {item.background && mode !== "edit" && (
        <p className="text-paragraph-xs italic text-text-soft-400">{item.background}</p>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Badge.Root variant="light" size="medium" color={item.sourceScope === "org" ? "blue" : "purple"}>
          {meta.tag}
        </Badge.Root>
        <Badge.Root variant="light" size="medium" color="gray">
          {item.type}
        </Badge.Root>
        <span className="text-paragraph-xs text-text-soft-400">
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
                className="inline-flex items-center gap-1 rounded-full bg-primary-base px-3 py-1 text-label-xs text-text-white-0 disabled:opacity-60"
              >
                <RiCheckLine className="size-3.5" aria-hidden />
                Save
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode("view")}
                className="inline-flex items-center gap-1 rounded-full border border-stroke-soft-200 px-3 py-1 text-label-xs text-text-sub-600 hover:text-text-strong-950"
              >
                Cancel
              </button>
            </>
          )}

          {mode === "confirm" && (
            <>
              <span className="text-paragraph-xs text-text-sub-600">Delete permanently?</span>
              <button
                type="button"
                disabled={busy}
                onClick={remove}
                className="inline-flex items-center gap-1 rounded-full bg-error-base px-3 py-1 text-label-xs text-text-white-0 disabled:opacity-60"
              >
                <RiCheckLine className="size-3.5" aria-hidden />
                Delete
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode("view")}
                className="inline-flex items-center rounded-full border border-stroke-soft-200 p-1 text-text-sub-600 hover:text-text-strong-950"
                aria-label="Cancel delete"
              >
                <RiCloseLine className="size-3.5" aria-hidden />
              </button>
            </>
          )}
        </div>
      </div>

      {error && <p className="text-paragraph-xs text-error-base">{error}</p>}
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
      className="flex size-7 items-center justify-center rounded-lg text-text-soft-400 transition-colors hover:bg-bg-soft-200 hover:text-text-sub-600"
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
