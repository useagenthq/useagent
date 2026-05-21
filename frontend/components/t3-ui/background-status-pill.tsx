"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/ChatView.tsx (backgroundLivenessBannerItem:
// the composer-anchored liveness banner - pulsing dot + status title + the
// Stop/"Stopping..." outline button that is the persistent stop affordance).
//
// Port notes: upstream builds a ComposerBannerStackItem for their banner stack;
// this port is the standalone slim pill. The label is a plain prop (upstream
// derives it from backgroundLiveness + fleet liveCount), the elapsed timer is
// added from their MessagesTimeline WorkingTimer pattern (self-ticking text
// node, no React commits - that component is private to working-indicator.tsx),
// and Stop accepts the EXISTING cancel handler as a prop (session-view
// handleStop posts the durable /cancel; no new API call here). Their
// animate-status-pulse -> our ai-loading-pixel; tokens are AlignUI semantic.

import { useEffect, useRef } from "react";
import { formatWorkingTimerNow } from "./work-entry";

/** Self-ticking elapsed label; updates its own text node outside React commits. */
function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(startedAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(startedAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

/**
 * Slim persistent status pill for a thread with live work: pulsing dot + status
 * label + elapsed (when a start time is known) + the Stop button. Purely
 * presentational; `onStop` is the existing durable cancel action.
 */
export function T3BackgroundStatusPill({
  label,
  startedAt,
  onStop,
  stopping = false,
}: {
  label: string;
  /** ISO start of the live work; absent hides the elapsed timer. */
  startedAt?: string | null;
  onStop: () => void;
  stopping?: boolean;
}) {
  return (
    <div
      data-t3-ui="background-status-pill"
      role="status"
      className="flex items-center gap-2 rounded-full border border-stroke-soft-200 bg-bg-weak-50 px-3 py-1.5 text-[12px] leading-5 text-text-strong-950 shadow-regular-xs"
    >
      <span
        className="ai-loading-pixel size-1.5 shrink-0 rounded-full bg-success-base"
        aria-hidden
      />
      <span className="min-w-0 truncate font-medium">{label}</span>
      {startedAt && (
        <span className="shrink-0 text-text-soft-400">
          for <ElapsedTimer startedAt={startedAt} />
        </span>
      )}
      <button
        type="button"
        disabled={stopping}
        onClick={onStop}
        className="ml-auto shrink-0 rounded-lg border border-stroke-soft-200 px-2 py-0.5 text-label-xs text-text-sub-600 transition-colors hover:bg-bg-soft-200 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {stopping ? "Stopping..." : "Stop"}
      </button>
    </div>
  );
}
