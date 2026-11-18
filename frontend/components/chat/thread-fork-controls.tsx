"use client";

import { RiArrowLeftUpLine, RiGitBranchLine } from "@remixicon/react";
import Link from "next/link";
import { memo, type MouseEvent, useCallback, useRef } from "react";
import { Focusable } from "react-aria-components";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import type { Turn } from "./conversation";
import type { ForkSource } from "./fork-prompt";
import { buildForkDraft, stashForkDraft } from "./thread-fork";

/** Stashes the history through a turn for the new-thread composer; true when
 *  it is ready to open. The source thread is never written to. Turns are read
 *  through a ref so the callback stays stable and memoized settled turns do
 *  not re-render as the thread streams. */
export function useForkStash(turns: readonly Turn[]): (runId: string) => boolean {
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  return useCallback((runId: string) => {
    const current = turnsRef.current;
    const threadId = current[0]?.run.thread_id;
    const draft = threadId
      ? buildForkDraft(
          threadId,
          current,
          runId,
          window.location.origin,
          process.env.NEXT_PUBLIC_CANONICAL_TIMELINE === "1",
        )
      : null;
    return draft !== null && stashForkDraft(runId, draft);
  }, []);
}

/** Opens the new-thread composer with the conversation up to this message.
 *  Sits beside the copy button in a settled answer's hover row and matches it. */
export const ForkFromHereButton = memo(function ForkFromHereButton({
  runId,
  onFork,
}: {
  runId: string;
  onFork: (runId: string) => boolean;
}) {
  // The history is stashed on click, before the link navigates.
  const fork = (event: MouseEvent) => {
    if (!onFork(runId)) event.preventDefault();
  };
  return (
    <TooltipTrigger delay={200}>
      <Focusable>
        <Link
          href={`/agent/new?fork=${encodeURIComponent(runId)}`}
          aria-label="Fork from here"
          onClick={fork}
          className="flex size-6 items-center justify-center rounded-md text-text-tertiary outline-none transition-colors hover:bg-background-secondary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <RiGitBranchLine className="size-3.5" aria-hidden />
        </Link>
      </Focusable>
      <Tooltip size="sm">Fork from here</Tooltip>
    </TooltipTrigger>
  );
});

/** Above a forked thread's first message: where it came from, linking back. */
export function ForkOrigin({ source }: { source: ForkSource }) {
  return (
    <div
      className="flex items-center justify-end gap-1.5 text-caption-1-regular text-text-tertiary"
      data-testid="fork-origin"
    >
      <RiGitBranchLine className="size-3.5 shrink-0" aria-hidden />
      <span>Forked after turn {source.turn} of</span>
      <Link
        href={`/session/${source.threadId}`}
        className="flex shrink-0 items-center gap-0.5 rounded text-caption-1-medium text-text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        the original thread
        <RiArrowLeftUpLine className="size-3" aria-hidden />
      </Link>
    </div>
  );
}
