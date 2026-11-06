"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/chat/MessagesTimeline.tsx (WorkingTimelineRow +
// WorkingTimer): three staggered pulse dots, a SELF-TICKING "Working for Xs" label
// (writes its own text node every second so elapsed time never causes a React
// commit while streaming), and an optional current-step suffix. The timer itself
// now lives in elapsed-timer.tsx, shared with the background status pill.
//
// Port notes: their `animate-status-pulse` utility -> our `ai-loading-pixel`
// stagger (globals.css, reduced-motion aware); tokens are our semantic tokens.

import { ElapsedTimer } from "./elapsed-timer";

export function WorkingIndicator({
  createdAt,
  stepLabel,
}: {
  createdAt?: string | null;
  stepLabel?: string | null;
}) {
  return (
    <div data-session-ui="working-indicator" className="py-0.5 pl-1.5">
      <div className="flex min-w-0 items-center gap-2 pt-1 text-[11px] text-text-secondary tabular-nums">
        <span className="inline-flex items-center gap-[3px]">
          {[0, 200, 400].map((delay) => (
            <span
              key={delay}
              className="ai-loading-pixel h-1 w-1 rounded-full bg-foreground-icon-tertiary"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
        <span className="shrink-0">
          {createdAt ? (
            <>
              Working for <ElapsedTimer startedAt={createdAt} />
            </>
          ) : (
            "Working…"
          )}
        </span>
        {stepLabel ? (
          <span className="min-w-0 truncate text-text-tertiary">· {stepLabel}</span>
        ) : null}
      </div>
    </div>
  );
}
