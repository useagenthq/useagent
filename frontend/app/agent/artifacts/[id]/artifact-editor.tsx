"use client";

import { RiArrowLeftLine, RiCodeSSlashLine, RiDownloadLine, RiEyeLine, RiSaveLine } from "@remixicon/react";
import type { ArtifactDescriptor } from "@skynet/agent-client";
import Link from "next/link";
import { useState } from "react";
import { WorkpieceProposalReview } from "@/components/artifacts/workpiece-proposal-review";
import { useWorkpieceEditor } from "./artifact-editor-state";
import { ArtifactFidelityNote, WorkpieceSurfaces } from "./artifact-editor-surfaces";

function ViewModeToggle({
  value,
  onChange,
}: {
  readonly value: "rendered" | "code";
  readonly onChange: (mode: "rendered" | "code") => void;
}) {
  return (
    <div className="inline-flex items-center rounded-lg border border-border-button-default p-0.5">
      {(
        [
          ["rendered", "Rendered", RiEyeLine],
          ["code", "Code", RiCodeSSlashLine],
        ] as const
      ).map(([mode, label, Icon]) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          aria-pressed={value === mode}
          className={
            value === mode
              ? "inline-flex h-7 items-center gap-1.5 rounded-md bg-foreground-icon-primary px-2.5 text-label-xs text-background-full"
              : "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-label-xs text-text-secondary hover:text-text-primary"
          }
        >
          <Icon aria-hidden className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

export function ArtifactEditor({ artifact }: { readonly artifact: ArtifactDescriptor }) {
  const editor = useWorkpieceEditor(artifact);
  const [viewMode, setViewMode] = useState<"rendered" | "code">("rendered");
  const workpiece = editor.workpiece;
  if (!workpiece) return null;
  const { actionContract } = editor;

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-[1120px] flex-1 flex-col px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/agent/artifacts"
            className="inline-flex items-center gap-1.5 text-body-2-medium text-text-secondary outline-none hover:text-text-primary focus-visible:underline"
          >
            <RiArrowLeftLine aria-hidden className="size-4" />
            Artifacts
          </Link>
          <h1 className="mt-3 text-display-sm text-text-primary">{artifact.name}</h1>
          <p className="mt-1 text-body-2-regular text-text-secondary">
            {editor.label} · revision {editor.revision}
          </p>
          {actionContract.edit && <ArtifactFidelityNote kind={workpiece.kind} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
          {actionContract.actions.includes("download") && (
            <a
              href={artifact.download_url}
              download={artifact.name}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-button-default bg-background-primary-default px-3 text-body-2-medium text-text-secondary outline-none hover:bg-background-secondary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2"
            >
              <RiDownloadLine aria-hidden className="size-4" /> Original
            </a>
          )}
          {actionContract.actions.includes("export") && workpiece.export_url && (
            <a
              href={workpiece.export_url}
              download
              aria-disabled={editor.loading}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-button-default bg-background-primary-default px-3 text-body-2-medium text-text-secondary outline-none hover:bg-background-secondary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RiDownloadLine aria-hidden className="size-4" /> Export
            </a>
          )}
          {actionContract.actions.includes("edit") && (
            <button
              type="button"
              onClick={() => void editor.save()}
              disabled={editor.loading || editor.saving || !editor.dirty}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-foreground-icon-primary px-4 text-body-2-medium text-background-full outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RiSaveLine aria-hidden className="size-4" /> {editor.saving ? "Saving..." : "Save"}
            </button>
          )}
        </div>
      </div>

      {editor.error && (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-border-error-default bg-background-tertiary-error px-4 py-3 text-body-2-regular text-text-error-primary"
        >
          {editor.error}
        </p>
      )}
      <div className="mt-5">
        <WorkpieceProposalReview artifact={artifact} />
      </div>
      <div className="mt-6 flex min-h-0 flex-1 flex-col">
        <WorkpieceSurfaces editor={editor} viewMode={viewMode} />
      </div>
    </main>
  );
}
