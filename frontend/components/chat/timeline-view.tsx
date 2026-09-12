"use client";

// The turn timeline RENDERER, split from conversation.tsx (which keeps turn
// orchestration: TurnBlock, composer, thread chrome). Everything here draws one
// turn's TimelineNode[]: its work as ONE trace block (./turn-trace), the plan
// checklist, the reply as the message, then the deliverables (file receipts,
// artifacts) and the closing sources + follow-up grammar. Shared by the session
// page and the /lab samples.

import {
  RiDownloadLine,
  RiExternalLinkLine,
  RiFileEditLine,
  RiFileLine,
  RiImageLine,
} from "@remixicon/react";
import {
  artifactAuthoringProfile,
  canPreviewInline,
  inferWorkpieceKind,
} from "@useagent/artifact-workspace";
import { memo, useMemo, useState } from "react";
import { PlanChecklist } from "@/components/agent-ui/plan-checklist";
import { formatArtifactSize } from "@/components/artifacts/model";
import { useComposerPrefill } from "@/components/chat/composer-prefill-context";
import { FollowUpRows } from "@/components/chat/follow-up-rows";
import { SourceChip } from "@/components/chat/source-chip";
import {
  deriveTurnSources,
  type TimelineArtifact,
  type TimelineNode,
  type TurnSource,
} from "@/components/chat/timeline";
import { failureRow, type TurnFailure, turnFailure } from "@/components/chat/turn-failure";
import { TurnTrace } from "@/components/chat/turn-trace";
import {
  latestPlanEntries,
  splitTurn,
  traceHeader,
  traceRowsFromWork,
} from "@/components/chat/turn-trace-model";
import { type ApiStep, basename, type RunStatus } from "@/components/chat/types";
import { useOpenWorkpiece } from "@/components/chat/workspace-open-context";
import { Markdown } from "@/components/prompt-kit/markdown";
import { changedFilesFromTimeline } from "@/components/session-ui/adapter";
import { ExpandedImageDialog } from "@/components/session-ui/expanded-image-dialog";
import { WorkingIndicator } from "@/components/session-ui/working-indicator";
import { cx as cn } from "@/utils/cx";

// Surface context only - the flow-element prose styling (headings, lists,
// links, paragraph rhythm) lives in the shared Markdown primitive
// (`prompt-kit/markdown.tsx` FLOW_CLASS) so EVERY consumer renders
// identically; this class adds the conversation turn's size and color.
export const MD_CLASS = "text-body-2-regular text-text-primary";

// Subdued variant of MD_CLASS for streamed reasoning (tailwind-merge lets the
// muted text color win over MD_CLASS's strong default).
export const MD_CLASS_REASONING = cn(MD_CLASS, "text-text-secondary");

/** One narration burst of the interleaved timeline — the same progressive-markdown
 *  treatment LiveNarration uses, memoized by its text so a streaming sibling burst
 *  or a completing tool never re-renders the settled ones (no fanout churn). */
const TextBurst = memo(function TextBurst({ text }: { text: string }) {
  return (
    <div className="animate-ai-fade-up" data-testid="agent-answer">
      <Markdown className={MD_CLASS}>{text}</Markdown>
    </div>
  );
});

function ArtifactActions({
  artifact,
  onOpen,
  previewLabel = `Preview ${artifact.name}`,
}: {
  artifact: TimelineArtifact;
  onOpen?: () => void;
  previewLabel?: string;
}) {
  const content = `/api/artifacts/${artifact.id}/content`;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${artifact.name} in workspace`}
          title="Open in workspace"
          className="flex size-8 items-center justify-center rounded-lg text-text-secondary outline-none hover:bg-background-primary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <RiExternalLinkLine aria-hidden className="size-4" />
        </button>
      ) : (
        <a
          href={content}
          target="_blank"
          rel="noreferrer"
          aria-label={previewLabel}
          title={previewLabel}
          className="flex size-8 items-center justify-center rounded-lg text-text-secondary outline-none hover:bg-background-primary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <RiExternalLinkLine aria-hidden className="size-4" />
        </a>
      )}
      <a
        href={`${content}?download=1`}
        download={artifact.name}
        aria-label={`Download ${artifact.name}`}
        title={`Download ${artifact.name}`}
        className="flex size-8 items-center justify-center rounded-lg text-text-secondary outline-none hover:bg-background-primary-default hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiDownloadLine aria-hidden className="size-4" />
      </a>
    </div>
  );
}

function artifactDestinations(artifact: TimelineArtifact): readonly string[] {
  return [
    ...new Set([
      ...(artifact.destinations ?? []),
      ...(artifact.destination ? [artifact.destination] : []),
    ]),
  ].toSorted();
}

function destinationLabel(destination: string): string {
  return destination
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function ArtifactDeliveryBadges({ destinations }: { destinations: readonly string[] }) {
  if (destinations.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {destinations.map((destination) => {
        const label = destinationLabel(destination);
        return (
          <span
            key={destination}
            className="rounded-md bg-background-primary-default px-1.5 py-0.5 text-caption-2-medium text-text-tertiary"
          >
            Delivered to {label}
          </span>
        );
      })}
    </div>
  );
}

function ArtifactRow({ node }: { node: Extract<TimelineNode, { kind: "artifact" }> }) {
  const { artifact } = node;
  const image = artifact.contentType.startsWith("image/") && canPreviewInline(artifact.contentType);
  const media = image || artifact.contentType.startsWith("video/");
  const Icon = media ? RiImageLine : RiFileLine;
  const content = `/api/artifacts/${artifact.id}/content`;
  const destinations = artifactDestinations(artifact);
  // Click-to-expand state stays local to the image artifact row.
  const [expanded, setExpanded] = useState(false);
  // A canonical workpiece (document/spreadsheet/deck/pdf) opens IN the session
  // side pane; raw binaries keep card/download. Delivery does not change content.
  const openWorkpiece = useOpenWorkpiece();
  const workpieceKind = openWorkpiece
    ? inferWorkpieceKind(artifact.name, artifact.contentType, artifact.bytes)
    : null;
  const canOpen = !!openWorkpiece && workpieceKind !== null;
  const subtitle = workpieceKind
    ? `${artifactAuthoringProfile(workpieceKind).label} · ${formatArtifactSize(artifact.bytes)} · Click to open`
    : `${media ? "Generated media" : "Artifact"} · ${formatArtifactSize(artifact.bytes)}`;
  const body = (
    <>
      <Icon aria-hidden className="size-5 shrink-0 text-text-secondary" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-2-medium text-text-primary">{artifact.name}</p>
        <p className="text-caption-1-regular text-text-tertiary">{subtitle}</p>
        <ArtifactDeliveryBadges destinations={destinations} />
      </div>
    </>
  );

  if (image) {
    return (
      <div className="min-w-0 overflow-hidden rounded-xl border border-border-button-default bg-background-secondary-default">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`Expand ${artifact.name}`}
          className="block w-full cursor-zoom-in bg-background-primary-default outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
        >
          {/* Authenticated dynamic artifact content is not a Next Image optimization target. */}
          <img
            src={content}
            alt={`Preview of ${artifact.name}`}
            loading="lazy"
            decoding="async"
            className="max-h-96 w-full object-contain"
          />
        </button>
        <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
          {body}
          <ArtifactActions artifact={artifact} />
        </div>
        {expanded && (
          <ExpandedImageDialog
            preview={{ images: [{ src: content, name: artifact.name }], index: 0 }}
            onClose={() => setExpanded(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-xl border border-border-button-default bg-background-secondary-default px-3 py-2.5",
        canOpen && "transition-colors hover:border-border-button-hover",
      )}
    >
      {canOpen ? (
        <button
          type="button"
          onClick={() => openWorkpiece?.(artifact)}
          aria-label={`Open ${artifact.name} in workspace`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          {body}
        </button>
      ) : (
        body
      )}
      <ArtifactActions
        artifact={artifact}
        onOpen={canOpen ? () => openWorkpiece?.(artifact) : undefined}
      />
    </div>
  );
}

function FileChangeRow({ node }: { node: Extract<TimelineNode, { kind: "file" }> }) {
  const { file } = node;
  const name = basename(file.path);
  const action =
    file.changeType === "create" ? "Created" : file.changeType === "delete" ? "Deleted" : "Edited";
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border-button-default bg-background-secondary-default px-3 py-2.5">
      <RiFileEditLine aria-hidden className="size-5 shrink-0 text-text-secondary" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-body-2-medium text-text-primary">{name}</p>
        <p className="truncate text-caption-1-regular text-text-tertiary">
          {action}
          {file.diff ? ` · diff ${formatArtifactSize(file.diff.bytes)}` : ""}
        </p>
      </div>
      {file.diff && (
        <ArtifactActions
          artifact={{
            id: file.diff.artifactId,
            name: `${name}.diff`,
            bytes: file.diff.bytes,
            sha256: file.diff.sha256,
            contentType: file.diff.contentType,
          }}
          previewLabel={`View diff for ${name}`}
        />
      )}
    </div>
  );
}

/** The web sources this turn actually fetched, as a quiet chip row closing the
 *  turn (beautiful-ui citation grammar; derived, never fabricated). */
function TurnSourcesRow({ sources }: { sources: readonly TurnSource[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="turn-sources">
      <span className="text-caption-1-medium text-text-tertiary">Sources</span>
      {sources.slice(0, 6).map((source) => (
        <SourceChip key={source.domain} domain={source.domain} href={source.href} />
      ))}
    </div>
  );
}

/** Suggested next questions closing the latest settled turn - picking one
 *  prefills the reply composer. Renders nothing without a composer (artifacts
 *  page, panes outside a session). */
function TimelineFollowups({ suggestions }: { suggestions: readonly string[] }) {
  const prefill = useComposerPrefill();
  if (!prefill) return null;
  return <FollowUpRows suggestions={suggestions} onPick={prefill} />;
}

/** How the turn's trace block opens: the run's own duration for the settled
 *  header, whether it starts open (plain threads) or folded (a bot's), and the
 *  run's terminal failure, which heads the trace and closes its rows. */
export interface TraceContext {
  readonly durationMs: number | null;
  readonly defaultOpen: boolean;
  readonly failure?: TurnFailure | null;
}

const DEFAULT_TRACE: TraceContext = { durationMs: null, defaultOpen: true };

/** One turn's trace context, from the run it renders. */
export function turnTraceContext(
  turn: {
    run: { duration_ms: number | null };
    status: RunStatus;
    summary: string | null;
    steps: readonly ApiStep[];
  },
  defaultOpen: boolean,
): TraceContext {
  return { durationMs: turn.run.duration_ms, defaultOpen, failure: turnFailure(turn) };
}

interface TimelineProps {
  nodes: TimelineNode[];
  live: boolean;
  workingSince?: string;
  /** Render this turn's follow-up suggestions (the LATEST turn only - stale
   *  suggestions under scrolled-back history are noise). */
  showFollowups?: boolean;
  trace?: TraceContext;
}

/**
 * One turn's timeline, read like chat: the work between the message and the
 * reply is ONE trace block (steps as short lines, opening to their payload),
 * the reply is the message, and the deliverables close the turn. Row models are
 * memoized on the node list, so a streaming sibling turn never rebuilds them.
 */
export function Timeline({
  nodes,
  live,
  workingSince,
  showFollowups = false,
  trace = DEFAULT_TRACE,
}: TimelineProps) {
  const { work, reply, tail } = useMemo(() => splitTurn(nodes, live), [nodes, live]);
  const failure = trace.failure ?? null;
  // A failed run closes its rows with the terminal failure, so even a run that
  // failed before any work still traces why.
  const rows = useMemo(() => {
    const workRows = traceRowsFromWork(work, live);
    return failure ? [...workRows, failureRow(failure)] : workRows;
  }, [work, live, failure]);
  // Durable file.changed receipts live in the closing tail, while edit/write
  // tool calls live in work. Aggregate the complete turn so either source feeds
  // the same compact changed-files strip.
  const files = useMemo(() => changedFilesFromTimeline(nodes), [nodes]);
  const header = useMemo(
    () =>
      traceHeader({
        live,
        rows,
        work,
        durationMs: trace.durationMs,
        changedFileCount: files.length,
        failure,
      }),
    [live, rows, work, trace.durationMs, files.length, failure],
  );
  const plan = useMemo(() => latestPlanEntries(work), [work]);
  // Cited web sources settle with the turn (the live list would churn row by row).
  const sources = useMemo(() => (live ? [] : deriveTurnSources(nodes)), [nodes, live]);
  return (
    <div className="space-y-3" data-testid="session-timeline">
      {(rows.length > 0 || files.length > 0) && (
        <TurnTrace
          rows={rows}
          header={header}
          files={files}
          live={live}
          defaultOpen={trace.defaultOpen}
        />
      )}
      {plan && (
        <PlanChecklist
          title="Todos"
          entries={plan}
          testId="todo-list"
          className="animate-ai-fade-up"
        />
      )}
      {reply && <TextBurst text={reply} />}
      {/* Nothing to trace yet and nothing said: the boot gap keeps a live signal. */}
      {live && rows.length === 0 && !reply && <WorkingIndicator createdAt={workingSince ?? null} />}
      {tail.map((node) =>
        node.kind === "file" ? (
          <FileChangeRow key={node.key} node={node} />
        ) : node.kind === "artifact" ? (
          <ArtifactRow key={node.key} node={node} />
        ) : null,
      )}
      {sources.length > 0 && <TurnSourcesRow sources={sources} />}
      {showFollowups &&
        tail.map((node) =>
          node.kind === "followups" ? (
            <TimelineFollowups key={node.key} suggestions={node.suggestions} />
          ) : null,
        )}
    </div>
  );
}
