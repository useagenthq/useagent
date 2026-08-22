"use client";

// The Diff surface pane - makes the chooser's "Diff - Available when a real
// patch exists" card real. Aggregates the WHOLE thread's changed files through
// the existing changed-files adapter (each turn projected to the same timeline
// nodes the conversation renders) and binds them to per-file unified-diff
// sections recovered from the steps' own recorded patch text.

import { useMemo } from "react";
import {
  buildTimelineFromCanonical,
  shouldUseCanonicalTimeline,
  type StoredCanonicalEvent,
} from "@/components/chat/canonical-timeline";
import type { NativeSnapshot } from "@/components/chat/native-store";
import { buildTimeline, type TimelineNode } from "@/components/chat/timeline";
import { type ApiStep, isRenderableTimelineStep } from "@/components/chat/types";
import { changedFilesFromTimeline } from "@/components/session-ui/adapter";
import { filePatchesFromSteps, FileDiffView } from "@/components/session-ui/file-diff-view";

// Same flag read as conversation.tsx (module-local there): the canonical lane
// drives a turn's projection only when its completion record landed (H2).
const CANONICAL_TIMELINE = process.env.NEXT_PUBLIC_CANONICAL_TIMELINE === "1";

/** The slice of a conversation Turn this pane reads (structural, so
 *  conversation's Turn assigns without importing its module). */
export interface DiffTurn {
  readonly steps: ApiStep[];
  readonly live: boolean;
  readonly native?: NativeSnapshot;
  readonly canonical?: readonly StoredCanonicalEvent[];
  readonly canonicalComplete?: boolean;
}

/** One turn -> the same timeline nodes the conversation renders (canonical when
 *  durably complete, else the native frame projection). Settled non-native
 *  history falls back to its durable steps as bare tool nodes - the
 *  changed-files adapter reads only tool + file nodes, so the projection is
 *  equivalent for this surface. */
export function timelineNodesForTurn(turn: DiffTurn): TimelineNode[] {
  if (turn.canonical && shouldUseCanonicalTimeline(CANONICAL_TIMELINE, turn)) {
    const stepsById = new Map(turn.steps.map((step) => [step.id, step]));
    return buildTimelineFromCanonical(turn.canonical, stepsById, turn.live);
  }
  const native = turn.native ? buildTimeline(turn.native, turn.live) : null;
  if (native) return native;
  return turn.steps
    .filter(isRenderableTimelineStep)
    .map((step): TimelineNode => ({ kind: "tool", key: step.id, step }));
}

export function DiffPane({ turns }: { turns: readonly DiffTurn[] }) {
  const { files, patches } = useMemo(
    () => ({
      files: changedFilesFromTimeline(turns.flatMap((turn) => timelineNodesForTurn(turn))),
      patches: filePatchesFromSteps(turns.flatMap((turn) => turn.steps)),
    }),
    [turns],
  );
  const live = turns.some((turn) => turn.live);

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="diff-pane">
        <p className="text-body-2-regular text-text-tertiary">
          {live ? "Waiting for the first file change…" : "No file changes were recorded."}
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pt-3" data-testid="diff-pane">
      <FileDiffView files={files} patches={patches} />
    </div>
  );
}
