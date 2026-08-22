"use client";

// skynet-a component (NOT vendored): a turn's leading context-recall receipts
// (skill/playbook loads + memory/knowledge retrievals) minified into ONE quiet
// disclosure, matching the "+N previous tool calls" fold grammar - a compact
// summary row with a chevron that expands to the individual MarkerRow rows. Only
// context-recall markers fold here; memory WRITE chips and the reconcile marker
// stay as their own rows (they are turn events, not context the run pulled in).

import { RiArrowDownSLine, RiSparkling2Line } from "@remixicon/react";
import { memo, useState } from "react";
import type { TimelineMarker } from "@/components/chat/timeline";
import { MarkerRow } from "@/components/chat/tool-step-row";
import { cx as cn } from "@/utils/cx";

/** A context marker the run pulled in (a skill/playbook load or a memory/
 *  knowledge retrieval). These fold; memory writes and the reconcile marker do
 *  not. */
export function isContextRecallMarker(marker: TimelineMarker): boolean {
  return marker.kind === "skill" || marker.kind === "context";
}

/** "5 memory, 7 knowledge, 1 playbook" - retrieval item counts summed per source,
 *  then the skill/playbook load counts, in first-seen order. */
export function summarizeContextRecall(markers: readonly TimelineMarker[]): string {
  const bySource = new Map<string, number>();
  let playbooks = 0;
  let skills = 0;
  for (const marker of markers) {
    if (marker.kind === "context") {
      bySource.set(marker.source, (bySource.get(marker.source) ?? 0) + marker.itemCount);
    } else if (marker.kind === "skill") {
      if (marker.playbook) playbooks += 1;
      else skills += 1;
    }
  }
  const parts: string[] = [];
  for (const [source, count] of bySource) parts.push(`${count} ${source}`);
  if (playbooks > 0) parts.push(`${playbooks} ${playbooks === 1 ? "playbook" : "playbooks"}`);
  if (skills > 0) parts.push(`${skills} ${skills === 1 ? "skill" : "skills"}`);
  return parts.join(", ");
}

/**
 * Collapse a turn's consecutive context-recall markers into one quiet fold. Feed
 * it 2+ markers (a lone receipt renders as its own MarkerRow instead - a fold of
 * one hides nothing). Collapsed by default; the individual rows render lazily on
 * expand, so nothing behind the fold hits the initial DOM.
 */
export const ContextRecallFold = memo(function ContextRecallFold({
  markers,
}: {
  markers: readonly { key: string; marker: TimelineMarker }[];
}) {
  const [open, setOpen] = useState(false);
  const summary = summarizeContextRecall(markers.map((m) => m.marker));

  return (
    <section data-session-ui="context-recall-fold" className="animate-ai-fade-up">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-background-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-purple-100 text-purple-500">
          <RiSparkling2Line className="size-3.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-body-2-medium font-medium text-text-secondary">Context</span>
          {summary && (
            <span className="ml-1.5 text-body-2-medium text-text-tertiary">{summary}</span>
          )}
        </span>
        <RiArrowDownSLine
          className={cn(
            "size-4 shrink-0 text-text-tertiary transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open && (
        <div className="mt-0.5 space-y-px">
          {markers.map(({ key, marker }) => (
            <MarkerRow key={key} marker={marker} />
          ))}
        </div>
      )}
    </section>
  );
});
