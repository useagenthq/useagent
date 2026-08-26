"use client";

// useAgent component (NOT vendored - T3 Code has no queued-message pill; the
// desktop screenshot's affordance is rebuilt here on OUR queue semantics).
// The backend runs ONE live turn per thread and queues replies as serial FIFO
// turns - there is no timed "send after Ns" countdown, so the pill states the
// honest position instead of a fabricated timer. "Send now" is the EXISTING
// steering action (session-view handleSendNow: cancel the running turn, the
// lane promotes the head queued turn), accepted as a prop - never a new call.

import { RiTimeLine } from "@remixicon/react";

/** Honest queue copy: position 1 waits only on the running turn; deeper
 *  positions also wait on the replies ahead of them. */
export function queuedPillLabel(position: number, waitingOnCurrentRun = true): string {
  if (!waitingOnCurrentRun) return "Queued - waiting to start";
  if (position <= 1) return "Queued - sends after the current run";
  const ahead = position - 1;
  return `Queued #${position} - ${ahead} ${ahead === 1 ? "reply" : "replies"} ahead`;
}

/**
 * Right-aligned pill under a queued reply bubble: its queue position, plus the
 * "Send now" steering affordance on the HEAD queued message only (pass
 * `onSendNow` just for that one, so queue order is preserved).
 */
export function QueuedMessagePill({
  position,
  waitingOnCurrentRun = true,
  onSendNow,
}: {
  /** 1-based place in this thread's queued-turn FIFO. */
  position: number;
  /** False for the thread's first/root run, which is waiting for admission rather than another turn. */
  waitingOnCurrentRun?: boolean;
  onSendNow?: () => void;
}) {
  return (
    <div data-session-ui="queued-message-pill" className="flex justify-end">
      <div
        role="status"
        className="flex w-fit max-w-full items-center gap-1.5 rounded-full border border-border-button-default bg-background-secondary-default px-2.5 py-1 text-[11px] leading-4 text-text-secondary tabular-nums"
      >
        <RiTimeLine className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
        <span className="truncate">{queuedPillLabel(position, waitingOnCurrentRun)}</span>
        {onSendNow && (
          <button
            type="button"
            onClick={onSendNow}
            title="Stops the current turn; this message starts immediately"
            className="shrink-0 cursor-pointer text-accent-500 underline-offset-2 outline-none hover:underline focus-visible:underline"
          >
            Send now
          </button>
        )}
      </div>
    </div>
  );
}
