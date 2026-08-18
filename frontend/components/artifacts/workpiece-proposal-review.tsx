"use client";

import {
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
} from "@skynet/agent-client";
import { useMemo, useState } from "react";
import { DiffStatLabel } from "@/components/session-ui/diff-stat-label";
import { DiffLines } from "@/components/session-ui/file-diff-view";
import { cn } from "@/utils/cn";
import { useWorkpieceProposals } from "./use-workpiece-proposals";
import {
  proposedPreviewText,
  type SheetCellChange,
  type SlideChange,
  workpieceProposalDiff,
  type WorkpieceProposalDiff,
} from "./workpiece-proposal-diff";

const SHEET_CELL_CAP = 200;

function NoChange() {
  return (
    <p className="rounded-10 border border-stroke-soft-200 px-3 py-2 text-paragraph-xs text-text-soft-400">
      This proposal matches the current version - nothing would change.
    </p>
  );
}

function SheetChanges({ cells }: { readonly cells: readonly SheetCellChange[] }) {
  const shown = cells.slice(0, SHEET_CELL_CAP);
  return (
    <div className="overflow-hidden rounded-10 border border-stroke-soft-200">
      <table className="w-full border-collapse text-left font-mono text-[11px]">
        <thead>
          <tr className="bg-bg-weak-50 text-text-soft-400">
            <th className="px-2 py-1 font-normal">Cell</th>
            <th className="px-2 py-1 font-normal">Before</th>
            <th className="px-2 py-1 font-normal">After</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((cell) => (
            <tr key={cell.ref} className="border-t border-stroke-soft-200/60">
              <td className="px-2 py-1 text-text-sub-600">{cell.ref}</td>
              <td className="px-2 py-1">
                <span className="rounded bg-error-base/10 px-1 text-text-sub-600">
                  {cell.before || " "}
                </span>
              </td>
              <td className="px-2 py-1">
                <span className="rounded bg-success-base/10 px-1 text-text-sub-600">
                  {cell.after || " "}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {cells.length > shown.length && (
        <p className="border-t border-stroke-soft-200 px-2 py-1 text-paragraph-xs text-text-soft-400">
          +{cells.length - shown.length} more changed cells
        </p>
      )}
    </div>
  );
}

function SlideChanges({ slides }: { readonly slides: readonly SlideChange[] }) {
  const KIND_LABEL: Record<SlideChange["kind"], string> = {
    added: "Added",
    removed: "Removed",
    changed: "Changed",
  };
  return (
    <div className="space-y-2">
      {slides.map((slide) => (
        <div
          key={slide.index}
          className="overflow-hidden rounded-10 border border-stroke-soft-200"
        >
          <div className="flex items-center gap-2 bg-bg-weak-50 px-2.5 py-1.5">
            <span className="text-label-xs text-text-strong-950">
              Slide {slide.index + 1}
            </span>
            <span className="text-paragraph-xs text-text-soft-400">{KIND_LABEL[slide.kind]}</span>
            <span className="min-w-0 flex-1 truncate text-paragraph-xs text-text-soft-400">
              {slide.label}
            </span>
          </div>
          <div className="divide-y divide-stroke-soft-200/60">
            {slide.fields.map((field) => (
              <div key={field.field} className="px-2.5 py-1.5">
                <p className="text-mono-label text-text-soft-400">{field.field}</p>
                {field.before && (
                  <p className="mt-0.5 whitespace-pre-wrap break-words rounded bg-error-base/10 px-1.5 py-0.5 font-mono text-[11px] text-text-sub-600">
                    {field.before}
                  </p>
                )}
                {field.after && (
                  <p className="mt-0.5 whitespace-pre-wrap break-words rounded bg-success-base/10 px-1.5 py-0.5 font-mono text-[11px] text-text-sub-600">
                    {field.after}
                  </p>
                )}
              </div>
            ))}
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
      <div className="max-h-72 overflow-auto rounded-10 border border-stroke-soft-200">
        <DiffLines lines={diff.lines} />
      </div>
    );
  }
  if (diff.type === "sheet") return <SheetChanges cells={diff.cells} />;
  return <SlideChanges slides={diff.slides} />;
}

export function ProposalCard({
  kind,
  proposal,
  mainlineState,
  busy,
  onAccept,
  onDismiss,
}: {
  readonly kind: ArtifactWorkpieceKind;
  readonly proposal: ArtifactWorkpieceProposalDescriptor;
  readonly mainlineState: ArtifactWorkpieceState | null;
  readonly busy: boolean;
  readonly onAccept: () => void;
  readonly onDismiss: () => void;
}) {
  const [view, setView] = useState<"diff" | "proposed">("diff");
  const diff = useMemo(
    () => workpieceProposalDiff(kind, mainlineState, proposal.state),
    [kind, mainlineState, proposal.state],
  );

  return (
    <div
      data-testid="workpiece-proposal-card"
      className="rounded-10 border border-stroke-soft-200 bg-bg-white-0 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-label-sm text-text-strong-950">
            {proposal.summary || "Proposed edit"}
          </p>
          <p className="text-paragraph-xs text-text-soft-400">
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
        <div className="inline-flex items-center rounded-lg border border-stroke-soft-200 p-0.5">
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
              className={cn(
                "inline-flex h-6 items-center rounded-md px-2 text-label-xs",
                view === mode
                  ? "bg-bg-strong-950 text-text-white-0"
                  : "text-text-sub-600 hover:text-text-strong-950",
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
          <div className="rounded-10 border border-stroke-soft-200">
            <p className="border-b border-stroke-soft-200 bg-bg-weak-50 px-3 py-1.5 text-mono-label text-text-soft-400">
              Proposed version - not applied
            </p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] text-text-sub-600">
              {proposedPreviewText(proposal.state) || " "}
            </pre>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-3 text-label-xs text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950 disabled:opacity-40"
        >
          <RiCloseLine aria-hidden className="size-3.5" /> Dismiss
        </button>
        <button
          type="button"
          onClick={onAccept}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-bg-strong-950 px-3 text-label-xs text-text-white-0 hover:opacity-90 disabled:opacity-40"
        >
          <RiCheckLine aria-hidden className="size-3.5" /> Accept
        </button>
      </div>
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
  busyId,
  error,
  onAccept,
  onDismiss,
  defaultOpen = false,
}: {
  readonly kind: ArtifactWorkpieceKind;
  readonly pending: readonly ArtifactWorkpieceProposalDescriptor[];
  readonly mainlineState: ArtifactWorkpieceState | null;
  readonly busyId: string | null;
  readonly error: string | null;
  readonly onAccept: (proposalId: string) => void;
  readonly onDismiss: (proposalId: string) => void;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (pending.length === 0) return null;

  return (
    <section
      data-testid="workpiece-proposal-review"
      aria-label="Agent proposed changes"
      className="shrink-0 overflow-hidden rounded-10 border border-feature-base/40 bg-feature-lighter/30"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-feature-base"
      >
        <RiSparkling2Line aria-hidden className="size-4 shrink-0 text-feature-base" />
        <span className="text-label-sm text-text-strong-950">
          Agent proposed {pending.length === 1 ? "a change" : `${pending.length} changes`}
        </span>
        <span className="text-paragraph-xs text-text-soft-400">Review</span>
        <RiArrowRightSLine
          aria-hidden
          className={cn(
            "ml-auto size-4 shrink-0 text-text-soft-400 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      {open && (
        <div className="space-y-3 border-t border-feature-base/30 p-3">
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-warning-base bg-warning-lighter px-3 py-2 text-paragraph-xs text-warning-base"
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
              onAccept={() => onAccept(proposal.id)}
              onDismiss={() => onDismiss(proposal.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** The agent-proposed-changes review lane for a workpiece: loads pending
 *  proposals + mainline and feeds the pure banner. The rendered surface keeps
 *  showing mainline until an accept lands; "View proposed" shows the proposed
 *  content, clearly labelled. Mounted by both the side pane and the full-page
 *  editor around the shared workpiece editor hook. */
export function WorkpieceProposalReview({ artifact }: { readonly artifact: ArtifactDescriptor }) {
  const workpiece = artifact.workpiece;
  const { pending, mainlineState, busyId, error, accept, dismiss } =
    useWorkpieceProposals(artifact);

  if (!workpiece) return null;

  return (
    <WorkpieceProposalBanner
      kind={workpiece.kind}
      pending={pending}
      mainlineState={mainlineState}
      busyId={busyId}
      error={error}
      onAccept={(id) => void accept(id)}
      onDismiss={(id) => void dismiss(id)}
    />
  );
}
