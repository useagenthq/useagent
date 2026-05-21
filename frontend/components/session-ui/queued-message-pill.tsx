"use client";

// skynet-a component (NOT vendored - T3 Code has no queued-message pill; the
// desktop screenshot's affordance is rebuilt here on OUR queue semantics).
// The backend runs ONE live turn per thread and queues replies as serial FIFO
// turns - there is no timed "send after Ns" countdown, so the pill states the
// honest position instead of a fabricated timer. "Send now" is the EXISTING
// steering action (session-view handleSendNow: cancel the running turn, the
// lane promotes the head queued turn), accepted as a prop - never a new call.

import { RiTimeLine } from "@remixicon/react";

/** Honest queue copy: position 1 waits only on the running turn; deeper
 *  positions also wait on the replies ahead of them. */
export function queuedPillLabel(position: number): string {
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
  onSendNow,
}: {
  /** 1-based place in this thread's queued-turn FIFO. */
  position: number;
  onSendNow?: () => void;
}) {
  return (
    <div data-session-ui="queued-message-pill" className="flex justify-end">
      <div
        role="status"
        className="flex w-fit max-w-full items-center gap-1.5 rounded-full border border-stroke-soft-200 bg-bg-weak-50 px-2.5 py-1 text-[11px] leading-4 text-text-sub-600 tabular-nums"
      >
        <RiTimeLine className="size-3.5 shrink-0 text-text-soft-400" aria-hidden />
        <span className="truncate">{queuedPillLabel(position)}</span>
        {onSendNow && (
          <button
            type="button"
            onClick={onSendNow}
            title="Stops the current turn; this message starts immediately"
            className="shrink-0 cursor-pointer text-primary-base underline-offset-2 outline-none hover:underline focus-visible:underline"
          >
            Send now
          </button>
        )}
      </div>
    </div>
  );
}
