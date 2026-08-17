"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Sources:
//   apps/web/src/components/chat/ProposedPlanCard.tsx (the card shell: Plan badge +
//     title header, collapsed markdown preview behind a bottom fade, the centered
//     Expand plan / Collapse plan toggle)
//   apps/web/src/proposedPlan.ts (proposedPlanTitle, stripDisplayedPlanMarkdown,
//     buildCollapsedProposedPlanPreviewMarkdown, buildPlanImplementationPrompt)
//
// Port notes: upstream binds to T3's client-runtime (atom commands, a save-to-
// workspace dialog, toasts, ChatMarkdown). This port is PROP-PURE: planMarkdown
// in, an optional onImplement callback out. Upstream approves a plan from the
// composer (resolvePlanFollowUpSubmission sends buildPlanImplementationPrompt as
// the next turn); the same grammar is exported here so the eventual wiring reuses
// it. Our canonical vocabulary has NO propose-plan event yet (plan.updated is a
// checklist snapshot; approval.requested is a tool-operation approval), so nothing
// feeds this card today - it renders from props and waits for backend plumbing.
// Markdown renders through the prompt-kit Markdown primitive; tokens are AlignUI
// semantic.

import { memo, useState } from "react";
import * as Badge from "@/components/ui/badge";
import * as Button from "@/components/ui/button";
import { Markdown } from "@/components/prompt-kit/markdown";
import { cn } from "@/utils/cn";

/** First markdown heading of the plan, upstream's card title. */
export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

/** Drop the leading title heading (it lives in the card header) and a redundant
 *  "Summary" heading right after it, exactly like upstream. */
export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  const sourceLines = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines];
  while (sourceLines[0]?.trim().length === 0) {
    sourceLines.shift();
  }
  const firstHeadingMatch = sourceLines[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (firstHeadingMatch?.[1]?.trim().toLowerCase() === "summary") {
    sourceLines.shift();
    while (sourceLines[0]?.trim().length === 0) {
      sourceLines.shift();
    }
  }
  return sourceLines.join("\n");
}

/** The collapsed preview: at most maxLines visible (non-blank) lines, then "...". */
export function buildCollapsedProposedPlanPreviewMarkdown(
  planMarkdown: string,
  options?: { maxLines?: number },
): string {
  const maxLines = options?.maxLines ?? 8;
  const lines = stripDisplayedPlanMarkdown(planMarkdown)
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const previewLines: string[] = [];
  let visibleLineCount = 0;
  let hasMoreContent = false;

  for (const line of lines) {
    const isVisibleLine = line.trim().length > 0;
    if (isVisibleLine && visibleLineCount >= maxLines) {
      hasMoreContent = true;
      break;
    }
    previewLines.push(line);
    if (isVisibleLine) {
      visibleLineCount += 1;
    }
  }

  while (previewLines.length > 0 && previewLines.at(-1)?.trim().length === 0) {
    previewLines.pop();
  }

  if (previewLines.length === 0) {
    return proposedPlanTitle(planMarkdown) ?? "Plan preview unavailable.";
  }

  if (hasMoreContent) {
    previewLines.push("", "...");
  }

  return previewLines.join("\n");
}

/** Upstream's approval grammar: the follow-up turn that asks the agent to execute. */
export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown.trim()}`;
}

/**
 * A plan the agent PROPOSES, shown for the user to review and approve before
 * execution. Purely presentational: pass the plan markdown; pass onImplement to
 * surface the approve action (it receives the upstream implementation prompt to
 * send as the next turn).
 */
export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  onImplement,
  defaultExpanded = false,
}: {
  planMarkdown: string;
  onImplement?: (implementationPrompt: string) => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  if (!planMarkdown.trim()) return null;

  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const collapsed = canCollapse && !expanded;
  const body = collapsed
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : stripDisplayedPlanMarkdown(planMarkdown);

  return (
    <section
      data-session-ui="proposed-plan-card"
      aria-label={title}
      className="rounded-20 border border-stroke-soft-200 bg-bg-white-0 p-4 shadow-regular-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge.Root variant="light" color="blue">
            Plan
          </Badge.Root>
          <p className="truncate text-label-sm text-text-strong-950">{title}</p>
        </div>
        {onImplement && (
          <Button.Root
            variant="primary"
            mode="filled"
            size="xxsmall"
            onClick={() => onImplement(buildPlanImplementationPrompt(planMarkdown))}
          >
            Implement plan
          </Button.Root>
        )}
      </div>
      <div className="mt-3">
        <div className={cn("relative", collapsed && "max-h-[26rem] overflow-hidden")}>
          <Markdown className="text-paragraph-sm text-text-sub-600">{body}</Markdown>
          {collapsed && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-bg-white-0 via-bg-white-0/80 to-transparent"
            />
          )}
        </div>
        {canCollapse && (
          <div className="mt-3 flex justify-center">
            <Button.Root
              variant="neutral"
              mode="stroke"
              size="xxsmall"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button.Root>
          </div>
        )}
      </div>
    </section>
  );
});
