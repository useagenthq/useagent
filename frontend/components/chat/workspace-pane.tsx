"use client";

import {
  RiCloseLine,
  RiCodeSSlashLine,
  RiDownloadLine,
  RiEyeLine,
  RiFilePdf2Line,
  RiFileTextLine,
  RiPagesLine,
  RiSaveLine,
  RiSlideshowLine,
  RiTableLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import { type ArtifactDescriptor, decodeArtifactResult } from "@skynet/agent-client";
import {
  type ArtifactWorkpieceKind,
  contentTypeForName,
  inferWorkpieceKind,
} from "@skynet/artifact-workspace";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkpieceEditor } from "@/app/agent/artifacts/[id]/artifact-editor-state";
import {
  ArtifactFidelityNote,
  PdfEmbedSurface,
  WorkpieceSurfaces,
} from "@/app/agent/artifacts/[id]/artifact-editor-surfaces";
import { EDIT_ACTIVITY_WINDOW_MS } from "@/components/artifacts/requested-edit-auto-accept";
import { WorkpieceProposalReview } from "@/components/artifacts/workpiece-proposal-review";
import { backendFetch } from "@/lib/backend-fetch";
import { cnExt as cn } from "@/utils/cn";

export interface OpenWorkpieceTab {
  readonly id: string;
  readonly name: string;
}

type ViewMode = "rendered" | "code";

const KIND_META: Record<ArtifactWorkpieceKind, { icon: RemixiconComponentType; label: string }> = {
  document: { icon: RiFileTextLine, label: "Document" },
  spreadsheet: { icon: RiTableLine, label: "Spreadsheet" },
  presentation: { icon: RiSlideshowLine, label: "Presentation" },
  pdf: { icon: RiFilePdf2Line, label: "PDF" },
};

function kindForName(name: string): ArtifactWorkpieceKind {
  return inferWorkpieceKind(name, contentTypeForName(name)) ?? "document";
}

/** The pane's internal tab strip: one tab per open workpiece (kind icon + name +
 * close), like the reference's multi-document workspace. */
export function WorkpieceTabStrip({
  tabs,
  activeId,
  unseenIds,
  onSelect,
  onClose,
}: {
  readonly tabs: readonly OpenWorkpieceTab[];
  readonly activeId: string | null;
  /** Tabs auto-opened without stealing focus (user was editing) - flagged with a
   * quiet dot so the new workpiece is noticeable without a disruptive switch. */
  readonly unseenIds?: readonly string[];
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-stroke-soft-200 px-2 py-1.5">
      {tabs.map((tab) => {
        const Icon = KIND_META[kindForName(tab.name)].icon;
        const active = tab.id === activeId;
        const unseen = !active && !!unseenIds?.includes(tab.id);
        return (
          <div
            key={tab.id}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-lg border pl-2 pr-1 text-label-xs transition-colors",
              active
                ? "border-stroke-sub-300 bg-bg-weak-50 text-text-strong-950"
                : unseen
                  ? "border-feature-base/40 bg-feature-lighter/30 text-text-strong-950"
                  : "border-transparent text-text-sub-600 hover:bg-bg-weak-50",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(tab.id)}
              aria-current={active}
              className="flex h-7 min-w-0 items-center gap-1.5 outline-none"
            >
              {unseen ? (
                <span
                  aria-label="New"
                  className="size-1.5 shrink-0 rounded-full bg-feature-base"
                />
              ) : (
                <Icon aria-hidden className="size-3.5 shrink-0 text-text-soft-400" />
              )}
              <span className="max-w-40 truncate">{tab.name}</span>
            </button>
            <button
              type="button"
              onClick={() => onClose(tab.id)}
              aria-label={`Close ${tab.name}`}
              title="Close"
              className="grid size-5 place-items-center rounded text-text-soft-400 hover:bg-bg-soft-200 hover:text-text-strong-950"
            >
              <RiCloseLine aria-hidden className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function SaveState({ saving, dirty }: { readonly saving: boolean; readonly dirty: boolean }) {
  const label = saving ? "Saving..." : dirty ? "Unsaved changes" : "Saved";
  const dot = saving ? "bg-away-base" : dirty ? "bg-warning-base" : "bg-success-base";
  return (
    <span className="inline-flex items-center gap-1.5 text-label-xs text-text-sub-600">
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden />
      {label}
    </span>
  );
}

/** The per-workpiece header: kind + revision, rendered|Code toggle, the quiet
 * saved/dirty indicator, and native/original export links. Pure - the fetch
 * wrapper and the lab harness both feed it. */
export function WorkpieceHeader({
  name,
  kindLabel,
  revision,
  viewMode,
  onViewMode,
  saving,
  dirty,
  editable,
  onSave,
  downloadUrl,
  exportUrl,
}: {
  readonly name: string;
  readonly kindLabel: string;
  readonly revision: number;
  readonly viewMode: ViewMode;
  readonly onViewMode: (mode: ViewMode) => void;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly editable: boolean;
  readonly onSave?: () => void;
  readonly downloadUrl?: string;
  readonly exportUrl?: string;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-label-sm text-text-strong-950" title={name}>
          {name}
        </p>
        <p className="text-paragraph-xs text-text-soft-400">
          {kindLabel} · revision {revision}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {editable && <SaveState saving={saving} dirty={dirty} />}
        <div className="inline-flex items-center rounded-lg border border-stroke-soft-200 p-0.5">
          {(
            [
              ["rendered", "Rendered", RiEyeLine],
              ["code", "Code", RiCodeSSlashLine],
            ] as const
          ).map(([mode, label, Icon]) => (
            <button
              key={mode}
              type="button"
              onClick={() => onViewMode(mode)}
              aria-pressed={viewMode === mode}
              title={label}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md px-2 text-label-xs",
                viewMode === mode
                  ? "bg-bg-strong-950 text-text-white-0"
                  : "text-text-sub-600 hover:text-text-strong-950",
              )}
            >
              <Icon aria-hidden className="size-3.5" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
        {downloadUrl && (
          <a
            href={downloadUrl}
            download={name}
            aria-label={`Download original ${name}`}
            title="Download original"
            className="grid size-7 place-items-center rounded-lg border border-stroke-soft-200 text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950"
          >
            <RiDownloadLine aria-hidden className="size-3.5" />
          </a>
        )}
        {exportUrl && (
          <a
            href={exportUrl}
            download
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-2 text-label-xs text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950"
          >
            <RiDownloadLine aria-hidden className="size-3.5" /> Export
          </a>
        )}
        {editable && onSave && dirty && (
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-bg-strong-950 px-2.5 text-label-xs text-text-white-0 hover:opacity-90 disabled:opacity-40"
          >
            <RiSaveLine aria-hidden className="size-3.5" /> Save
          </button>
        )}
      </div>
    </div>
  );
}

/** The mounted editor for one loaded workpiece descriptor. Auto-saves (debounced)
 * through the shared revision flow. Reports its dirty state up so an auto-open
 * never steals focus from an edit in progress. */
function WorkpieceEditorView({
  artifact,
  onDirtyChange,
}: {
  readonly artifact: ArtifactDescriptor;
  readonly onDirtyChange?: (dirty: boolean) => void;
}) {
  const editor = useWorkpieceEditor(artifact, { autosave: true });
  const [viewMode, setViewMode] = useState<ViewMode>("rendered");
  const dirty = editor.dirty;
  // Report dirty by identity-stable ref so the effect fires only on real change
  // (not every render) and reports clean on unmount.
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
    return () => onDirtyChangeRef.current?.(false);
  }, [dirty]);
  // Requested-edit auto-accept gate: read live (from refs) at the instant an agent
  // proposal arrives, so a clean+idle editor applies the change directly while an
  // edit in flight (dirty) or a just-touched editor (typed/focused within the
  // window) always keeps the proposal banner. markActivity fires on focus/typing
  // inside the workspace surface below.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const lastActivityRef = useRef<number | null>(null);
  const markActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);
  const readEditorGate = useCallback(
    () => ({
      dirty: dirtyRef.current,
      recentlyActive:
        lastActivityRef.current !== null &&
        Date.now() - lastActivityRef.current < EDIT_ACTIVITY_WINDOW_MS,
    }),
    [],
  );
  const workpiece = editor.workpiece;
  if (!workpiece) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkpieceHeader
        name={artifact.name}
        kindLabel={KIND_META[workpiece.kind].label}
        revision={editor.revision}
        viewMode={viewMode}
        onViewMode={setViewMode}
        saving={editor.saving}
        dirty={editor.dirty}
        editable={!!editor.actionContract.edit}
        onSave={() => void editor.save()}
        downloadUrl={artifact.download_url}
        exportUrl={
          editor.actionContract.actions.includes("export") ? workpiece.export_url : undefined
        }
      />
      {editor.actionContract.edit && (
        <details className="shrink-0 border-t border-stroke-soft-200 px-3 py-1.5">
          <summary className="cursor-pointer text-label-xs text-text-sub-600 outline-none marker:text-text-soft-400 hover:text-text-strong-950">
            What edits are preserved
          </summary>
          <div className="pt-2">
            <ArtifactFidelityNote kind={workpiece.kind} />
          </div>
        </details>
      )}
      {editor.error && (
        <p
          role="alert"
          className="mx-3 mt-2 shrink-0 rounded-lg border border-error-base bg-error-lighter px-3 py-2 text-paragraph-xs text-error-base"
        >
          {editor.error}
        </p>
      )}
      <div className="px-3 pt-2">
        <WorkpieceProposalReview artifact={artifact} editorGate={readEditorGate} />
      </div>
      {/* Marks the live editing region: an auto-open checks whether focus sits
          inside a workspace surface here before it decides to steal focus, and
          focus/typing here marks recent activity so a requested-edit auto-accept
          never lands on top of an edit in progress. */}
      <div
        data-workspace-surface
        onFocusCapture={markActivity}
        onInputCapture={markActivity}
        className="flex min-h-0 flex-1 flex-col overflow-auto px-3 pb-3"
      >
        <WorkpieceSurfaces editor={editor} viewMode={viewMode} />
      </div>
    </div>
  );
}

/** Loads one artifact descriptor by id and mounts its workpiece editor. Only a
 * canonical workpiece opens here; anything else keeps its download affordance. */
function WorkpieceEditorPane({
  artifactId,
  onDirtyChange,
}: {
  readonly artifactId: string;
  readonly onDirtyChange?: (dirty: boolean) => void;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "unsupported"; artifact: ArtifactDescriptor }
    | { status: "ready"; artifact: ArtifactDescriptor }
  >({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const response = await backendFetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`artifact request failed (${response.status})`);
        const result = decodeArtifactResult(await response.json());
        if (!result) throw new Error("artifact response was invalid");
        setState(
          result.artifact.workpiece
            ? { status: "ready", artifact: result.artifact }
            : { status: "unsupported", artifact: result.artifact },
        );
      } catch (cause) {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : "The file could not be opened.",
        });
      }
    })();
    return () => controller.abort();
  }, [artifactId]);

  if (state.status === "loading") {
    return (
      <div className="grid h-full place-items-center p-6 text-paragraph-sm text-text-sub-600">
        Loading workspace...
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-paragraph-sm text-error-base">
        {state.message}
      </div>
    );
  }
  if (state.status === "unsupported") {
    // An Office binary that is not editable here still gets a rendered-PDF preview
    // when the sandbox produced one; otherwise it stays a plain download.
    if (state.artifact.preview_pdf_url) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
            <p className="truncate text-label-sm text-text-strong-950" title={state.artifact.name}>
              {state.artifact.name}
            </p>
            <a
              href={state.artifact.download_url}
              download={state.artifact.name}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-2.5 text-label-xs text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950"
            >
              <RiDownloadLine aria-hidden className="size-3.5" /> Download original
            </a>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto px-3 pb-3">
            <PdfEmbedSurface
              url={state.artifact.preview_pdf_url}
              note="Preview rendered from the Office file. Download the original to open or edit it."
            />
          </div>
        </div>
      );
    }
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="text-label-sm text-text-strong-950">Not an editable workpiece</p>
          <p className="mt-1 text-paragraph-xs text-text-sub-600">
            This file opens as a download.
          </p>
          <a
            href={state.artifact.download_url}
            download={state.artifact.name}
            className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-3 text-label-xs text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950"
          >
            <RiDownloadLine aria-hidden className="size-3.5" /> Download
          </a>
        </div>
      </div>
    );
  }
  return <WorkpieceEditorView artifact={state.artifact} onDirtyChange={onDirtyChange} />;
}

/** The session side-pane Workspace surface: an internal tab strip over each open
 * workpiece and its structured editor. Every open workpiece stays mounted (only
 * the active one is visible) so switching tabs never drops in-flight edits. */
export function WorkspacePane({
  tabs,
  activeId,
  unseenIds,
  onSelect,
  onClose,
  onDirtyChange,
}: {
  readonly tabs: readonly OpenWorkpieceTab[];
  readonly activeId: string | null;
  /** Auto-opened-but-unfocused tabs, surfaced with a quiet dot in the strip. */
  readonly unseenIds?: readonly string[];
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
  /** Reports each open editor's dirty state by id so the session can protect an
   * in-progress edit from an auto-open focus switch. */
  readonly onDirtyChange?: (id: string, dirty: boolean) => void;
}) {
  if (tabs.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="flex flex-col items-center">
          <RiPagesLine className="size-5 text-text-soft-400" aria-hidden />
          <p className="mt-3 text-label-sm text-text-strong-950">No workpiece open</p>
          <p className="mt-1 text-paragraph-xs text-text-sub-600">
            Open a document, spreadsheet, or deck from the conversation to edit it here.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col">
      <WorkpieceTabStrip
        tabs={tabs}
        activeId={activeId}
        unseenIds={unseenIds}
        onSelect={onSelect}
        onClose={onClose}
      />
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            aria-hidden={tab.id !== activeId}
            className={cn(
              "absolute inset-0",
              tab.id === activeId ? "visible" : "pointer-events-none invisible",
            )}
          >
            <WorkpieceEditorPane
              artifactId={tab.id}
              onDirtyChange={
                onDirtyChange ? (dirty) => onDirtyChange(tab.id, dirty) : undefined
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}
