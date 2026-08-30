"use client";

// The interleaved turn timeline RENDERER, split from conversation.tsx (which
// keeps turn orchestration: TurnBlock, composer, thread chrome). Everything
// here draws TimelineNode[] for one turn: narration bursts, tool work groups,
// markers, artifact/file receipt rows, and the closing sources + follow-up
// grammar. Shared by the session page and the /lab samples.

import {
  RiDownloadLine,
  RiExternalLinkLine,
  RiFileEditLine,
  RiFileLine,
  RiImageLine,
  RiSlackLine,
} from "@remixicon/react";
import { artifactAuthoringProfile, inferWorkpieceKind } from "@useagent/artifact-workspace";
import { memo, useMemo, useState } from "react";
import { PlanChecklist } from "@/components/agent-ui/plan-checklist";
import { Thinking } from "@/components/ai/thinking";
import { formatArtifactSize } from "@/components/artifacts/model";
import { useComposerPrefill } from "@/components/chat/composer-prefill-context";
import { FollowUpRows } from "@/components/chat/follow-up-rows";
import { SourceChip } from "@/components/chat/source-chip";
import {
  deriveTurnSources,
  type TimelineArtifact,
  type TimelineMarker,
  type TimelineNode,
  type TurnSource,
} from "@/components/chat/timeline";
import { MarkerRow } from "@/components/chat/tool-step-row";
import { basename } from "@/components/chat/types";
import { useOpenWorkpiece } from "@/components/chat/workspace-open-context";
import { Markdown } from "@/components/prompt-kit/markdown";
import {
  segmentTimeline,
  type TimelineSegment,
} from "@/components/session-ui/adapter";
import {
  ContextRecallFold,
  isContextRecallMarker,
} from "@/components/session-ui/context-recall-fold";
import { ExpandedImageDialog } from "@/components/session-ui/expanded-image-dialog";
import { WorkGroup } from "@/components/session-ui/work-group";
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

/** A SETTLED reasoning burst in the interleaved timeline: a collapsed, subdued
 *  "Thought" disclosure (reuses the Thinking primitive, inactive - no shimmer),
 *  expandable to read the real thoughts. Duration is intentionally omitted -
 *  native frames carry no timestamps, so deriving one would break the canonical
 *  vs native timeline equivalence the reducers are held to. */
const SettledThought = memo(function SettledThought({ text }: { text: string }) {
  return (
    <Thinking label="Thought" active={false}>
      <div data-testid="settled-thought">
        <Markdown className={MD_CLASS_REASONING}>{text}</Markdown>
      </div>
    </Thinking>
  );
});

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

function ArtifactRow({ node }: { node: Extract<TimelineNode, { kind: "artifact" }> }) {
  const { artifact } = node;
  const image = artifact.contentType.startsWith("image/");
  const media = image || artifact.contentType.startsWith("video/");
  const Icon = media ? RiImageLine : RiFileLine;
  // Click-to-expand lightbox for image artifacts with local content (delivered
  // artifacts have no content endpoint here). Leaf-local state only - no store.
  const [expanded, setExpanded] = useState(false);
  const expandable = image && !artifact.destination;
  // A canonical workpiece (document/spreadsheet/deck/pdf, not a delivered copy)
  // opens IN the session side pane; raw binaries keep card/download. The provider
  // is null outside a session (the standalone artifacts page), so the card keeps
  // its plain behavior there.
  const openWorkpiece = useOpenWorkpiece();
  const workpieceKind =
    openWorkpiece && !artifact.destination
      ? inferWorkpieceKind(artifact.name, artifact.contentType, artifact.bytes)
      : null;
  const canOpen = !!openWorkpiece && workpieceKind !== null;
  const subtitle = artifact.destination
    ? `Delivered to ${artifact.destination}`
    : workpieceKind
      ? `${artifactAuthoringProfile(workpieceKind).label} · ${formatArtifactSize(artifact.bytes)} · Click to open`
      : `${media ? "Generated media" : "Artifact"} · ${formatArtifactSize(artifact.bytes)}`;
  const body = (
    <>
      <Icon aria-hidden className="size-5 shrink-0 text-text-secondary" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-2-medium text-text-primary">{artifact.name}</p>
        <p className="text-caption-1-regular text-text-tertiary">{subtitle}</p>
      </div>
    </>
  );
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
      ) : expandable ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`Expand ${artifact.name}`}
          className="flex min-w-0 flex-1 cursor-zoom-in items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          {body}
        </button>
      ) : (
        body
      )}
      {artifact.destination === "slack" && (
        <RiSlackLine
          aria-label="Delivered to Slack"
          className="size-4 shrink-0 text-text-tertiary"
        />
      )}
      {!artifact.destination && (
        <ArtifactActions
          artifact={artifact}
          onOpen={canOpen ? () => openWorkpiece?.(artifact) : undefined}
        />
      )}
      {expanded && (
        <ExpandedImageDialog
          preview={{
            images: [{ src: `/api/artifacts/${artifact.id}/content`, name: artifact.name }],
            index: 0,
          }}
          onClose={() => setExpanded(false)}
        />
      )}
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

/**
 * The interleaved turn timeline: narration bursts and the tool work that followed
 * them, in TRUE ORDER (opencode-style). Non-tool nodes (markers, text, reasoning,
 * artifacts, files) keep their own renderers; consecutive tool nodes fold into the
 * vendored T3 work grammar (compact rows, expand disclosure, failed/success
 * affordances, "+N previous tool calls" overflow). While live, the in-flight tool
 * is represented by the T3 working indicator's step suffix (upstream filters
 * in-progress rows from the group), which also replaces the old LoadingState tail.
 */
/** One render unit of the flow: either a fold of consecutive context-recall
 *  markers, or a single passthrough segment. */
type FlowUnit =
  | { kind: "recall"; key: string; markers: { key: string; marker: TimelineMarker }[] }
  | { kind: "seg"; seg: TimelineSegment };

/**
 * Fold a turn's consecutive context-recall markers (skill/playbook loads +
 * memory/knowledge retrievals) into ONE quiet disclosure, like the "+N previous
 * tool calls" fold. A lone receipt renders as its own MarkerRow (a fold of one
 * hides nothing); memory writes and the reconcile marker never fold - they are
 * turn events, not context the run pulled in.
 */
function groupContextRecall(segs: readonly TimelineSegment[]): FlowUnit[] {
  const units: FlowUnit[] = [];
  let run: { key: string; marker: TimelineMarker }[] = [];
  const flush = () => {
    if (run.length >= 2) {
      units.push({ kind: "recall", key: `recall-${run[0].key}`, markers: run });
    } else if (run.length === 1) {
      const { key, marker } = run[0];
      units.push({ kind: "seg", seg: { kind: "node", key, node: { kind: "marker", key, marker } } });
    }
    run = [];
  };
  for (const seg of segs) {
    if (seg.kind === "node" && seg.node.kind === "marker" && isContextRecallMarker(seg.node.marker)) {
      run.push({ key: seg.key, marker: seg.node.marker });
    } else {
      flush();
      units.push({ kind: "seg", seg });
    }
  }
  flush();
  return units;
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

export function Timeline({
  nodes,
  live,
  workingSince,
  showFollowups = false,
}: {
  nodes: TimelineNode[];
  live: boolean;
  workingSince?: string;
  /** Render this turn's follow-up suggestions (the LATEST turn only - stale
   *  suggestions under scrolled-back history are noise). */
  showFollowups?: boolean;
}) {
  const { segments, workingLabel } = useMemo(
    () => segmentTimeline(nodes, live),
    [nodes, live],
  );
  // Artifacts are deliverables, not narration: they render AFTER the prose and
  // tool activity so an answer never appears below its own attachment.
  // Follow-ups close the turn after everything else.
  const artifactSegs = segments.filter((s) => s.kind === "node" && s.node.kind === "artifact");
  const followupSegs = segments.filter((s) => s.kind === "node" && s.node.kind === "followups");
  const flowSegs = segments.filter(
    (s) => s.kind !== "node" || (s.node.kind !== "artifact" && s.node.kind !== "followups"),
  );
  const flowUnits = groupContextRecall(flowSegs);
  // Cited web sources settle with the turn (the live list would churn row by row).
  const sources = useMemo(() => (live ? [] : deriveTurnSources(nodes)), [nodes, live]);
  return (
    <div className="space-y-3" data-testid="session-timeline">
      {flowUnits.map((unit) =>
        unit.kind === "recall" ? (
          <ContextRecallFold key={unit.key} markers={unit.markers} />
        ) : unit.seg.kind === "tools" ? (
          <WorkGroup
            key={unit.seg.key}
            stateKey={`work:${unit.seg.key}`}
            entries={unit.seg.entries}
            turnSettled={!live}
          />
        ) : unit.seg.kind === "plan" ? (
          <PlanChecklist
            key={unit.seg.key}
            title="Todos"
            entries={unit.seg.entries}
            testId="todo-list"
            className="animate-ai-fade-up"
          />
        ) : unit.seg.node.kind === "marker" ? (
          <MarkerRow key={unit.seg.key} marker={unit.seg.node.marker} />
        ) : unit.seg.node.kind === "artifact" ? (
          <ArtifactRow key={unit.seg.key} node={unit.seg.node} />
        ) : unit.seg.node.kind === "file" ? (
          <FileChangeRow key={unit.seg.key} node={unit.seg.node} />
        ) : unit.seg.node.kind === "reasoning" ? (
          <SettledThought key={unit.seg.key} text={unit.seg.node.text} />
        ) : unit.seg.node.kind === "followups" ? null : (
          <TextBurst key={unit.seg.key} text={unit.seg.node.text} />
        ),
      )}
      {artifactSegs.map((seg) =>
        seg.kind === "node" && seg.node.kind === "artifact" ? (
          <ArtifactRow key={seg.key} node={seg.node} />
        ) : null,
      )}
      {sources.length > 0 && <TurnSourcesRow sources={sources} />}
      {showFollowups &&
        followupSegs.map((seg) =>
          seg.kind === "node" && seg.node.kind === "followups" ? (
            <TimelineFollowups key={seg.key} suggestions={seg.node.suggestions} />
          ) : null,
        )}
      {live && <WorkingIndicator createdAt={workingSince ?? null} stepLabel={workingLabel} />}
    </div>
  );
}
