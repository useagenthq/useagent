"use client";

import {
  RiArrowGoBackLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiCloseLine,
  RiSparkling2Line,
} from "@remixicon/react";
import type {
  ArtifactDescriptor,
  ArtifactWorkpieceKind,
  ArtifactWorkpieceProposalDescriptor,
  ArtifactWorkpieceState,
} from "@useagent/agent-client";
import { useEffect, useMemo, useState } from "react";
import { useComposerPrefill } from "@/components/chat/composer-prefill-context";
import { useSessionLatestRun } from "@/components/chat/session-run-context";
import { DiffStatLabel } from "@/components/session-ui/diff-stat-label";
import { DiffLines } from "@/components/session-ui/file-diff-view";
import { cx } from "@/utils/cx";
import {
  proposalConflictsWithMainline,
  type RequestedEditAutoAcceptToast,
  useWorkpieceProposals,
} from "./use-workpiece-proposals";
import {
  type DeckBlockChange,
  type DeckSlideChange,
  proposedPreviewText,
  type SheetCellChange,
  workpieceProposalDiff,
  type WorkpieceProposalDiff,
} from "./workpiece-proposal-diff";

const SHEET_CELL_CAP = 200;

/** How long an "Agent edit applied - Undo" toast lingers before it quietly clears. */
const AUTO_ACCEPT_TOAST_MS = 10_000;

/** The reply seeded by "Ask agent to redo" on a conflicted proposal: asks the
 *  agent to re-author its change against the CURRENT version so the new proposal
 *  applies cleanly. Pure so the wording stays testable. */
export function askAgentRedoMessage(summary: string | null, artifactName: string): string {
  const change = summary?.trim() ? `'${summary.trim()}'` : "the proposed edit";
  return `Re-propose your change ${change} against the current version of ${artifactName}.`;
}

function NoChange() {
  return (
    <p className="rounded-2lg border border-border-button-default px-3 py-2 text-caption-1-regular text-text-tertiary">
      This proposal matches the current version - nothing would change.
    </p>
  );
}

function SheetChanges({ cells }: { readonly cells: readonly SheetCellChange[] }) {
  const shown = cells.slice(0, SHEET_CELL_CAP);
  const multiSheet = new Set(cells.map((cell) => cell.sheet)).size > 1;
  return (
    <div className="overflow-hidden rounded-2lg border border-border-button-default">
      <table className="w-full border-collapse text-left font-mono text-[11px]">
        <thead>
          <tr className="bg-background-secondary-default text-text-tertiary">
            <th className="px-2 py-1 font-normal">Cell</th>
            <th className="px-2 py-1 font-normal">Before</th>
            <th className="px-2 py-1 font-normal">After</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((cell) => (
            <tr key={`${cell.sheet}-${cell.ref}`} className="border-t border-border-button-default/60">
              <td className="px-2 py-1 text-text-secondary">
                {multiSheet ? `${cell.sheet}!${cell.ref}` : cell.ref}
                {cell.formatChanged && cell.before === cell.after && (
                  <span className="ml-1 rounded bg-purple-500/10 px-1 text-purple-600">fmt</span>
                )}
              </td>
              <td className="px-2 py-1">
                <span className="rounded bg-red-500/10 px-1 text-text-secondary">
                  {cell.before || " "}
                </span>
              </td>
              <td className="px-2 py-1">
                <span className="rounded bg-lime-500/10 px-1 text-text-secondary">
                  {cell.after || " "}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {cells.length > shown.length && (
        <p className="border-t border-border-button-default px-2 py-1 text-caption-1-regular text-text-tertiary">
          +{cells.length - shown.length} more changed cells
        </p>
      )}
    </div>
  );
}

const SLIDE_KIND_LABEL: Record<DeckSlideChange["kind"], string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
};
const BLOCK_KIND_LABEL: Record<DeckBlockChange["kind"], string> = {
  added: "added",
  removed: "removed",
  moved: "moved",
  edited: "edited",
};
const BLOCK_KIND_TONE: Record<DeckBlockChange["kind"], string> = {
  added: "bg-lime-500/10 text-lime-600",
  removed: "bg-red-500/10 text-text-error-primary",
  moved: "bg-background-secondary-default text-text-secondary",
  edited: "bg-purple-500/10 text-purple-600",
};

/** Block-level summary of a deck proposal: added/removed/moved/edited blocks per
 * slide, plus a deck-theme-change note. */
function SlideChanges({
  slides,
  themeChanged,
}: {
  readonly slides: readonly DeckSlideChange[];
  readonly themeChanged: boolean;
}) {
  return (
    <div className="space-y-2">
      {themeChanged && (
        <p className="rounded-2lg border border-border-button-default bg-background-secondary-default px-2.5 py-1.5 text-caption-1-regular text-text-secondary">
          Deck theme changed (background and colors).
        </p>
      )}
      {slides.map((slide) => (
        <div
          key={slide.index}
          className="overflow-hidden rounded-2lg border border-border-button-default"
        >
          <div className="flex items-center gap-2 bg-background-secondary-default px-2.5 py-1.5">
            <span className="text-caption-1-medium text-text-primary">
              Slide {slide.index + 1}
            </span>
            <span className="text-caption-1-regular text-text-tertiary">
              {SLIDE_KIND_LABEL[slide.kind]}
            </span>
            <span className="min-w-0 flex-1 truncate text-caption-1-regular text-text-tertiary">
              {slide.label}
            </span>
          </div>
          <div className="divide-y divide-border-button-default/60">
            {slide.blocks.map((block) => (
              <div key={block.id} className="flex items-center gap-2 px-2.5 py-1.5">
                <span className="text-mono-label text-text-tertiary">{block.type}</span>
                <span className={cx("rounded px-1 text-[11px]", BLOCK_KIND_TONE[block.kind])}>
                  {BLOCK_KIND_LABEL[block.kind]}
                </span>
                <span className="min-w-0 flex-1 truncate text-caption-1-regular text-text-secondary">
                  {block.label}
                </span>
              </div>
            ))}
            {(slide.backgroundChanged || slide.notesChanged) && (
              <p className="px-2.5 py-1.5 text-caption-1-regular text-text-tertiary">
                {[slide.backgroundChanged && "background", slide.notesChanged && "notes"]
                  .filter(Boolean)
                  .join(", ")}{" "}
                changed
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ProposalDiffBody({ diff }: { readonly diff: WorkpieceProposalDiff }) {
  if (diff.unchanged) return <NoChange />;
  if (diff.type === "text") {
    return (
      <div className="space-y-2">
        {diff.themeChanged && (
          <p className="rounded-2lg border border-border-button-default bg-background-secondary-default px-2.5 py-1.5 text-caption-1-regular text-text-secondary">
            Document theme changed (background and colors).
          </p>
        )}
        {diff.lines.length > 0 && (
          <div className="max-h-72 overflow-auto rounded-2lg border border-border-button-default">
            <DiffLines lines={diff.lines} />
          </div>
        )}
      </div>
    );
  }
  if (diff.type === "sheet") return <SheetChanges cells={diff.cells} />;
  return <SlideChanges slides={diff.slides} themeChanged={diff.themeChanged} />;
}

export function ProposalCard({
  kind,
  proposal,
  mainlineState,
  busy,
  conflicted = false,
  onAccept,
  onDismiss,
  onAskRedo,
}: {
  readonly kind: ArtifactWorkpieceKind;
  readonly proposal: ArtifactWorkpieceProposalDescriptor;
  readonly mainlineState: ArtifactWorkpieceState | null;
  readonly busy: boolean;
  /** Mainline advanced past this proposal's base revision: accepting would 409
   *  forever, so Accept is disabled and the user is steered to re-propose. */
  readonly conflicted?: boolean;
  readonly onAccept: () => void;
  readonly onDismiss: () => void;
  /** Seeds the composer to ask the agent to re-propose against current mainline.
   *  Absent outside a session (the standalone editor has no composer). */
  readonly onAskRedo?: () => void;
}) {
  const [view, setView] = useState<"diff" | "proposed">("diff");
  const diff = useMemo(
    () => workpieceProposalDiff(kind, mainlineState, proposal.state),
    [kind, mainlineState, proposal.state],
  );

  return (
    <div
      data-testid="workpiece-proposal-card"
      className="rounded-2lg border border-border-button-default bg-background-primary-default p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-body-2-medium text-text-primary">
            {proposal.summary || "Proposed edit"}
          </p>
          <p className="text-caption-1-regular text-text-tertiary">
            from run {proposal.proposer_run_id.slice(0, 8)}
            {diff.type === "text" && !diff.unchanged && (
              <>
                {" · "}
                <DiffStatLabel
                  additions={diff.additions}
                  deletions={diff.deletions}
                  layout="inline"
                />
              </>
            )}
          </p>
        </div>
        <div className="inline-flex items-center rounded-lg border border-border-button-default p-0.5">
          {(
            [
              ["diff", "Diff"],
              ["proposed", "View proposed"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              aria-pressed={view === mode}
              className={cx(
                "inline-flex h-6 items-center rounded-md px-2 text-caption-1-medium",
                view === mode
                  ? "bg-foreground-icon-primary text-background-full"
                  : "text-text-secondary hover:text-text-primary",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2">
        {view === "diff" ? (
          <ProposalDiffBody diff={diff} />
        ) : (
          <div className="rounded-2lg border border-border-button-default">
            <p className="border-b border-border-button-default bg-background-secondary-default px-3 py-1.5 text-mono-label text-text-tertiary">
              Proposed version - not applied
            </p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] text-text-secondary">
              {proposedPreviewText(proposal.state) || " "}
            </pre>
          </div>
        )}
      </div>

      {conflicted ? (
        // Dead-end guard: mainline moved on, so Accept can only 409. Explain why
        // inline, make Dismiss the primary action, and offer a one-click re-propose.
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-caption-1-regular text-yellow-600">
            Cannot apply - written against an older version
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled
              aria-disabled
              title="This proposal was written against an older version and can no longer be applied."
              className="inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-lg border border-border-button-default px-3 text-caption-1-medium text-text-disabled"
            >
              <RiCheckLine aria-hidden className="size-3.5" /> Accept
            </button>
            {onAskRedo && (
              <button
                type="button"
                onClick={onAskRedo}
                disabled={busy}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-button-default px-3 text-caption-1-medium text-text-secondary hover:bg-background-primary-hover hover:text-text-primary disabled:opacity-40"
              >
                <RiSparkling2Line aria-hidden className="size-3.5" /> Ask agent to redo
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-button-primary px-3 text-caption-1-medium text-text-white hover:opacity-90 disabled:opacity-40"
            >
              <RiCloseLine aria-hidden className="size-3.5" /> Dismiss
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-button-default px-3 text-caption-1-medium text-text-secondary hover:bg-background-primary-hover hover:text-text-primary disabled:opacity-40"
          >
            <RiCloseLine aria-hidden className="size-3.5" /> Dismiss
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-button-primary px-3 text-caption-1-medium text-text-white hover:opacity-90 disabled:opacity-40"
          >
            <RiCheckLine aria-hidden className="size-3.5" /> Accept
          </button>
        </div>
      )}
    </div>
  );
}

/** Pure presentational banner: a quiet header announcing pending proposals that
 *  expands to per-proposal diff cards with Accept/Dismiss. Prop-driven so both
 *  the hook wrapper and tests can feed it. Renders nothing when none pend. */
export function WorkpieceProposalBanner({
  kind,
  pending,
  mainlineState,
  mainlineRevision = null,
  busyId,
  error,
  onAccept,
  onDismiss,
  onAskRedo,
  defaultOpen = false,
}: {
  readonly kind: ArtifactWorkpieceKind;
  readonly pending: readonly ArtifactWorkpieceProposalDescriptor[];
  readonly mainlineState: ArtifactWorkpieceState | null;
  /** Current mainline revision - a proposal whose base_revision is behind it is a
   *  conflict (Accept would 409). Null (unknown) treats every proposal as clean. */
  readonly mainlineRevision?: number | null;
  readonly busyId: string | null;
  readonly error: string | null;
  readonly onAccept: (proposalId: string) => void;
  readonly onDismiss: (proposalId: string) => void;
  /** Ask the agent to re-propose a conflicted change against current mainline. */
  readonly onAskRedo?: (proposal: ArtifactWorkpieceProposalDescriptor) => void;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (pending.length === 0) return null;

  return (
    <section
      data-testid="workpiece-proposal-review"
      aria-label="Agent proposed changes"
      className="shrink-0 overflow-hidden rounded-2lg border border-border-button-default bg-background-secondary-default"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
      >
        <RiSparkling2Line aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
        <span className="text-body-2-medium text-text-primary">
          Agent proposed {pending.length === 1 ? "a change" : `${pending.length} changes`}
        </span>
        <span className="text-caption-1-regular text-text-tertiary">Review</span>
        <RiArrowRightSLine
          aria-hidden
          className={cx(
            "ml-auto size-4 shrink-0 text-text-tertiary transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border-button-default p-3">
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-yellow-500/40 bg-status-yellow-background px-3 py-2 text-caption-1-regular text-status-yellow-text"
            >
              {error}
            </p>
          )}
          {pending.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              kind={kind}
              proposal={proposal}
              mainlineState={mainlineState}
              busy={busyId !== null}
              conflicted={proposalConflictsWithMainline(proposal, mainlineRevision)}
              onAccept={() => onAccept(proposal.id)}
              onDismiss={() => onDismiss(proposal.id)}
              onAskRedo={onAskRedo ? () => onAskRedo(proposal) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** One quiet "Agent edit applied - Undo" toast. Our design language, not an alarm:
 *  a compact card that self-clears after AUTO_ACCEPT_TOAST_MS unless the user acts.
 *  Undo re-saves the pre-accept state as a new revision through the normal lane. */
function RequestedEditToast({
  toast,
  onUndo,
  onDismiss,
}: {
  readonly toast: RequestedEditAutoAcceptToast;
  readonly onUndo: (id: string) => void;
  readonly onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    if (toast.status !== "applied") return;
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_ACCEPT_TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast.status, toast.id, onDismiss]);

  return (
    <div className="animate-ai-fade-up flex items-center gap-2 rounded-2lg border border-border-button-default bg-background-primary-default px-3 py-2 shadow-sm">
      <RiSparkling2Line aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-2-medium text-text-primary">Agent edit applied</p>
        {toast.summary && (
          <p className="truncate text-caption-1-regular text-text-tertiary">{toast.summary}</p>
        )}
      </div>
      {toast.status === "error" ? (
        <span className="text-caption-1-regular text-yellow-600">Could not undo</span>
      ) : (
        <button
          type="button"
          onClick={() => onUndo(toast.id)}
          disabled={toast.status === "undoing"}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border-button-default px-2.5 text-caption-1-medium text-text-secondary hover:bg-background-primary-hover hover:text-text-primary disabled:opacity-40"
        >
          <RiArrowGoBackLine aria-hidden className="size-3.5" />
          {toast.status === "undoing" ? "Undoing..." : "Undo"}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="grid size-6 shrink-0 place-items-center rounded text-text-tertiary hover:bg-background-primary-hover hover:text-text-primary"
      >
        <RiCloseLine aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}

function RequestedEditToasts({
  toasts,
  onUndo,
  onDismiss,
}: {
  readonly toasts: readonly RequestedEditAutoAcceptToast[];
  readonly onUndo: (id: string) => void;
  readonly onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2">
      {toasts.map((toast) => (
        <RequestedEditToast key={toast.id} toast={toast} onUndo={onUndo} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/** The agent-proposed-changes review lane for a workpiece: loads pending
 *  proposals + mainline and feeds the pure banner. The rendered surface keeps
 *  showing mainline until an accept lands; "View proposed" shows the proposed
 *  content, clearly labelled. Mounted by both the side pane and the full-page
 *  editor around the shared workpiece editor hook.
 *
 *  Inside a session, a proposal that lands on an OPEN, clean, idle workpiece from
 *  the user's own latest run applies directly (their chat message was the
 *  acceptance): the rendered view refreshes through the existing live-reload lane
 *  and a quiet Undo toast appears. `editorGate` (the open editor's dirty +
 *  recent-activity signal) enables that; without it, or without a session run, the
 *  normal banner is the only path. */
export function WorkpieceProposalReview({
  artifact,
  editorGate,
}: {
  readonly artifact: ArtifactDescriptor;
  readonly editorGate?: () => { readonly dirty: boolean; readonly recentlyActive: boolean };
}) {
  const workpiece = artifact.workpiece;
  const latestRunId = useSessionLatestRun();
  const {
    pending,
    mainlineState,
    mainlineRevision,
    busyId,
    error,
    accept,
    dismiss,
    autoAcceptToasts,
    undoAutoAccept,
    dismissAutoAcceptToast,
  } = useWorkpieceProposals(
    artifact,
    // Auto-accept is a session affordance: it needs both the thread's latest run
    // and the open editor's live gate. The standalone editor supplies neither.
    editorGate && latestRunId !== null ? { latestRunId, readEditorGate: editorGate } : undefined,
  );
  // Only present inside a session (the standalone editor page has no composer);
  // absent -> the "Ask agent to redo" affordance hides itself.
  const prefillComposer = useComposerPrefill();

  if (!workpiece) return null;

  return (
    <div className="flex flex-col gap-2">
      <WorkpieceProposalBanner
        kind={workpiece.kind}
        pending={pending}
        mainlineState={mainlineState}
        mainlineRevision={mainlineRevision}
        busyId={busyId}
        error={error}
        onAccept={(id) => void accept(id)}
        onDismiss={(id) => void dismiss(id)}
        onAskRedo={
          prefillComposer
            ? (proposal) => prefillComposer(askAgentRedoMessage(proposal.summary, artifact.name))
            : undefined
        }
      />
      <RequestedEditToasts
        toasts={autoAcceptToasts}
        onUndo={(id) => void undoAutoAccept(id)}
        onDismiss={dismissAutoAcceptToast}
      />
    </div>
  );
}
