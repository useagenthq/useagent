"use client";

import {
  type RemixiconComponentType,
  RiCloseLine,
  RiCodeSSlashLine,
  RiDownloadLine,
  RiEyeLine,
  RiFilePdf2Line,
  RiFileTextLine,
  RiPagesLine,
  RiSaveLine,
  RiSendPlane2Line,
  RiSlideshowLine,
  RiSparkling2Line,
  RiTableLine,
} from "@remixicon/react";
import { type ArtifactDescriptor, decodeArtifactResult } from "@useagent/agent-client";
import {
  type ArtifactWorkpieceKind,
  contentTypeForName,
  inferWorkpieceKind,
} from "@useagent/artifact-workspace";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkpieceEditor } from "@/app/agent/artifacts/[id]/artifact-editor-state";
import {
  ArtifactFidelityNote,
  PdfEmbedSurface,
  WorkpieceSurfaces,
} from "@/app/agent/artifacts/[id]/artifact-editor-surfaces";
import { EDIT_ACTIVITY_WINDOW_MS } from "@/components/artifacts/requested-edit-auto-accept";
import { workpieceFollowUpMessage } from "@/components/artifacts/workpiece-follow-up";
import { WorkpieceProposalReview } from "@/components/artifacts/workpiece-proposal-review";
import { StatusDot } from "@/components/base/badges/status-dot";
import { Button, ButtonLink } from "@/components/base/buttons/button";
import { IconLinkButton } from "@/components/base/buttons/icon-button";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { useComposerPrefill } from "@/components/chat/composer-prefill-context";
import { backendFetch } from "@/lib/backend-fetch";
import { cx } from "@/utils/cx";

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
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border-button-default px-2 py-1.5">
      {tabs.map((tab) => {
        const Icon = KIND_META[kindForName(tab.name)].icon;
        const active = tab.id === activeId;
        const unseen = !active && !!unseenIds?.includes(tab.id);
        return (
          <div
            key={tab.id}
            className={cx(
              "flex shrink-0 items-center gap-1 rounded-lg border pl-2 pr-1 text-caption-1-medium transition-colors",
              active
                ? "border-border-button-hover bg-background-secondary-default text-text-primary"
                : unseen
                  ? "border-accent-500/40 bg-accent-100/30 text-text-primary"
                  : "border-transparent text-text-secondary hover:bg-background-primary-hover",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(tab.id)}
              aria-current={active}
              className="flex h-7 min-w-0 items-center gap-1.5 outline-none"
            >
              {unseen ? (
                <>
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent-500" />
                  <span className="sr-only">New</span>
                </>
              ) : (
                <Icon aria-hidden className="size-3.5 shrink-0 text-foreground-icon-tertiary" />
              )}
              <span className="max-w-40 truncate">{tab.name}</span>
            </button>
            <button
              type="button"
              onClick={() => onClose(tab.id)}
              aria-label={`Close ${tab.name}`}
              title="Close"
              className="grid size-5 place-items-center rounded text-foreground-icon-tertiary hover:bg-background-tertiary-default hover:text-text-primary"
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
  const color = saving ? ("indigo" as const) : dirty ? ("yellow" as const) : ("green" as const);
  return (
    <span className="inline-flex items-center gap-1 text-caption-1-medium text-text-secondary">
      <StatusDot color={color} />
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
        <p className="truncate text-body-2-medium text-text-primary" title={name}>
          {name}
        </p>
        <p className="text-caption-1-regular text-text-tertiary">
          {kindLabel} · revision {revision}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {editable && <SaveState saving={saving} dirty={dirty} />}
        <PillTabList
          aria-label="View mode"
          className="rounded-2lg border border-border-button-default p-0.5"
        >
          {(
            [
              ["rendered", "Rendered", RiEyeLine],
              ["code", "Code", RiCodeSSlashLine],
            ] as const
          ).map(([mode, label, Icon]) => (
            <PillTab
              key={mode}
              variant="gray"
              icon={Icon}
              isSelected={viewMode === mode}
              onSelect={() => onViewMode(mode)}
              title={label}
            >
              <span className="hidden sm:inline">{label}</span>
            </PillTab>
          ))}
        </PillTabList>
        {downloadUrl && (
          <IconLinkButton
            icon={RiDownloadLine}
            size="small"
            href={downloadUrl}
            download={name}
            aria-label={`Download original ${name}`}
            title="Download original"
          />
        )}
        {exportUrl && (
          <ButtonLink
            variant="secondary"
            size="xs"
            leadingIcon={RiDownloadLine}
            href={exportUrl}
            download
          >
            Export
          </ButtonLink>
        )}
        {editable && onSave && dirty && (
          <Button
            variant="primary"
            size="xs"
            leadingIcon={RiSaveLine}
            onClick={onSave}
            disabled={saving}
          >
            Save
          </Button>
        )}
      </div>
    </div>
  );
}

/** The per-workpiece "Ask a follow-up" composer in the pane header: a compact
 * input that seeds the session reply composer with a typed workpieceRef context
 * prefix (id + name + kind + revision) so the agent edits exactly this canonical
 * document (its edits then flow propose/auto-accept as normal). Reuses the
 * composer-prefill lane, so outside a session (the standalone editor page has no
 * composer) it hides itself. */
export function WorkpieceFollowUpComposer({
  artifact,
  kind,
  revision,
}: {
  readonly artifact: ArtifactDescriptor;
  readonly kind: ArtifactWorkpieceKind;
  readonly revision: number;
}) {
  const prefillComposer = useComposerPrefill();
  const [text, setText] = useState("");
  if (!prefillComposer) return null;

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    prefillComposer(
      workpieceFollowUpMessage(
        { artifactId: artifact.id, name: artifact.name, kind, revision },
        trimmed,
      ),
    );
    setText("");
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-border-button-default px-3 py-2">
      <RiSparkling2Line aria-hidden className="size-4 shrink-0 text-purple-500" />
      <input
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        aria-label="Ask a follow-up about this file"
        placeholder="Ask a follow-up about this file..."
        className="h-8 min-w-0 flex-1 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 text-caption-1-medium text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus-ring"
      />
      <Button
        variant="primary"
        size="small"
        iconOnly
        leadingIcon={RiSendPlane2Line}
        onClick={submit}
        disabled={!text.trim()}
        aria-label="Send follow-up"
        title="Send to the agent"
        className="shrink-0"
      />
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
        kindLabel={KIND_META[workpiece.kind as ArtifactWorkpieceKind].label}
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
      <WorkpieceFollowUpComposer
        artifact={artifact}
        kind={workpiece.kind}
        revision={editor.revision}
      />
      {editor.actionContract.edit && (
        <details className="shrink-0 border-t border-border-button-default px-3 py-1.5">
          <summary className="cursor-pointer text-caption-1-medium text-text-secondary outline-none marker:text-text-tertiary hover:text-text-primary">
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
          className="mx-3 mt-2 shrink-0 rounded-lg border border-border-error-default bg-red-50 px-3 py-2 text-caption-1-regular text-red-500"
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
      <div className="grid h-full place-items-center p-6 text-body-2-regular text-text-secondary">
        Loading workspace...
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-body-2-regular text-red-500">
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
            <p
              className="truncate text-body-2-medium text-text-primary"
              title={state.artifact.name}
            >
              {state.artifact.name}
            </p>
            <ButtonLink
              variant="secondary"
              size="xs"
              leadingIcon={RiDownloadLine}
              href={state.artifact.download_url}
              download={state.artifact.name}
            >
              Download original
            </ButtonLink>
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
          <p className="text-body-2-medium text-text-primary">Not an editable workpiece</p>
          <p className="mt-1 text-caption-1-regular text-text-secondary">
            This file opens as a download.
          </p>
          <ButtonLink
            variant="secondary"
            size="small"
            leadingIcon={RiDownloadLine}
            href={state.artifact.download_url}
            download={state.artifact.name}
            className="mt-3"
          >
            Download
          </ButtonLink>
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
          <RiPagesLine className="size-5 text-text-tertiary" aria-hidden />
          <p className="mt-3 text-body-2-medium text-text-primary">No workpiece open</p>
          <p className="mt-1 text-caption-1-regular text-text-secondary">
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
            className={cx(
              "absolute inset-0",
              tab.id === activeId ? "visible" : "pointer-events-none invisible",
            )}
          >
            <WorkpieceEditorPane
              artifactId={tab.id}
              onDirtyChange={onDirtyChange ? (dirty) => onDirtyChange(tab.id, dirty) : undefined}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
