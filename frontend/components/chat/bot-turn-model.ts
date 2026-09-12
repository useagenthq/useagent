// A bot thread's turn, read like chat: the person's message, the bot's reply,
// and everything in between folded behind one line. This is the pure model
// behind that view - which nodes are the work, which burst is the reply, and
// the fold's label ("Worked for 3m 12s, 14 steps" settled, "Working, <step>"
// live). The React side lives in ./timeline-view (BotTurn) + ./bot-work-fold.

import { formatWorkingTimer } from "@/components/session-ui/work-entry";
import { workedForDuration } from "@/components/session-ui/worked-for-fold";
import type { TimelineNode } from "./timeline";
import { summarizeToolStep } from "./tool-summary";
import { deriveTrace } from "./types";

export interface BotTurnSplit {
  /** Everything the bot did between the message and its reply, in true order. */
  readonly work: TimelineNode[];
  /** The reply: the last narration burst once settled, or the burst still
   *  streaming at the tail while live. Null until the bot has said something. */
  readonly reply: string | null;
  /** Deliverables and follow-up suggestions that close the turn after the reply. */
  readonly tail: TimelineNode[];
}

/**
 * Split a turn's timeline into the folded work, the reply, and the closing tail.
 * While live, only a burst at the very end counts as the reply-in-progress; a
 * burst followed by more work was narration and folds with it.
 */
export function splitBotTurn(nodes: readonly TimelineNode[], live: boolean): BotTurnSplit {
  const flow = nodes.filter((node) => node.kind !== "artifact" && node.kind !== "followups");
  const tail = nodes.filter((node) => node.kind === "artifact" || node.kind === "followups");
  const replyIndex = live
    ? flow.at(-1)?.kind === "text"
      ? flow.length - 1
      : -1
    : flow.findLastIndex((node) => node.kind === "text");
  let replyStart = replyIndex;
  while (replyStart > 0 && flow[replyStart - 1]?.kind === "text") replyStart -= 1;
  const replyNodes = replyIndex >= 0 ? flow.slice(replyStart, replyIndex + 1) : [];
  return {
    work: flow.filter((_, index) => index < replyStart || index > replyIndex),
    reply: replyNodes.length > 0
      ? replyNodes.map((node) => node.kind === "text" ? node.text : "").join("\n\n")
      : null,
    tail,
  };
}

export function botWorkFailureCount(work: readonly TimelineNode[]): number {
  return work.filter((node) => node.kind === "tool" && deriveTrace(node.step).isError).length;
}

/** The latest thing the bot is doing, from the summarizer; null with no steps yet. */
export function latestStepLabel(work: readonly TimelineNode[]): string | null {
  for (let index = work.length - 1; index >= 0; index -= 1) {
    const node = work[index];
    if (node?.kind === "tool") return summarizeToolStep(node.step).label;
    if (node?.kind === "reasoning") return "Thinking";
  }
  return null;
}

function formatDurationMs(durationMs: number | null): string | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return formatWorkingTimer(new Date(0).toISOString(), new Date(durationMs).toISOString());
}

/** The fold's one line: live progress, or the settled duration + step count. */
export function botWorkLabel({
  live,
  work,
  durationMs,
}: {
  live: boolean;
  work: readonly TimelineNode[];
  /** The settled run's own duration; falls back to the work's step timestamps. */
  durationMs: number | null;
}): string {
  if (live) {
    const step = latestStepLabel(work);
    return step ? `Working, ${step}` : "Working";
  }
  const steps = work.filter((node) => node.kind !== "text").length;
  const stepsText = `${steps} ${steps === 1 ? "step" : "steps"}`;
  const duration = formatDurationMs(durationMs) ?? workedForDuration(work);
  const failures = botWorkFailureCount(work);
  const failureText = failures > 0 ? `, ${failures} failed` : "";
  return duration
    ? `Worked for ${duration}, ${stepsText}${failureText}`
    : `Worked, ${stepsText}${failureText}`;
}
