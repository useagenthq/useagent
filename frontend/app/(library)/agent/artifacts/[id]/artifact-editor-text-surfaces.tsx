"use client";

// Text-document surfaces for the workpiece editor, split out of
// artifact-editor-surfaces.tsx: the plain editable source textarea, and the
// markdown surfaces (a formatted Rendered preview plus the editable Code
// source). Kept here so the shared surface switcher stays under its size cap.

import { Markdown } from "@/components/prompt-kit/markdown";
import type { WorkpieceEditorController } from "./artifact-editor-state";

/** The plain editable source surface for a text document, and the Code view of
 * a markdown document: a monospace textarea bound to the canonical source. */
export function SourceSurface({
  label,
  loading,
  value,
  onChange,
}: {
  readonly label: string;
  readonly loading: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <>
      <label htmlFor="workpiece-source" className="text-body-2-medium text-text-primary">
        {label}
      </label>
      <textarea
        id="workpiece-source"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={loading}
        className="mt-2 min-h-[420px] w-full flex-1 resize-y rounded-xl border border-border-button-default bg-background-primary-default p-4 font-mono text-body-2-regular text-text-primary outline-none focus:border-foreground-icon-primary focus:ring-2 focus:ring-border-button-default disabled:opacity-50"
      />
    </>
  );
}

/** Markdown document surfaces: Rendered shows the formatted document, read-only,
 * with the same renderer the conversation uses, so headings, bold, lists, code
 * and tables look the way they do in a reply. Code holds the editable raw
 * source, so the Rendered view never shows "##" or backticks. */
export function MarkdownWorkpieceSurface({
  editor,
  viewMode,
}: {
  readonly editor: WorkpieceEditorController;
  readonly viewMode: "rendered" | "code";
}) {
  if (viewMode === "code") {
    return (
      <SourceSurface
        label={editor.label}
        loading={editor.loading}
        value={editor.value}
        onChange={editor.setSource}
      />
    );
  }
  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col">
      <p className="text-caption-1-regular text-text-tertiary">
        Rendered preview. Switch to Code to edit the markdown.
      </p>
      <div className="mt-2 min-h-[420px] flex-1 overflow-auto rounded-xl border border-border-button-default bg-background-primary-default p-5">
        {editor.loading ? (
          <p className="text-body-2-regular text-text-tertiary">Loading…</p>
        ) : editor.value.trim() ? (
          <Markdown>{editor.value}</Markdown>
        ) : (
          <p className="text-body-2-regular text-text-tertiary">This document is empty.</p>
        )}
      </div>
    </div>
  );
}
