"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/chat/MessagesTimeline.tsx (WorkingTimelineRow +
// WorkingTimer): three staggered pulse dots, a SELF-TICKING "Working for Xs" label
// (writes its own text node every second so elapsed time never causes a React
// commit while streaming), and an optional current-step suffix.
//
// Port notes: their `animate-status-pulse` utility -> our `ai-loading-pixel`
// stagger (globals.css, reduced-motion aware); tokens are AlignUI semantic.

import { useEffect, useRef } from "react";
import { formatWorkingTimerNow } from "./work-entry";

/** Live "Working for Xs" label; updates its own text node outside React commits. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

export function T3WorkingIndicator({
  createdAt,
  stepLabel,
}: {
  createdAt?: string | null;
  stepLabel?: string | null;
}) {
  return (
    <div data-t3-ui="working-indicator" className="py-0.5 pl-1.5">
      <div className="flex min-w-0 items-center gap-2 pt-1 text-[11px] text-text-sub-600 tabular-nums">
        <span className="inline-flex items-center gap-[3px]">
          {[0, 200, 400].map((delay) => (
            <span
              key={delay}
              className="ai-loading-pixel h-1 w-1 rounded-full bg-text-soft-400"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
        <span className="shrink-0">
          {createdAt ? (
            <>
              Working for <WorkingTimer createdAt={createdAt} />
            </>
          ) : (
            "Working..."
          )}
        </span>
        {stepLabel ? (
          <span className="min-w-0 truncate text-text-soft-400">· {stepLabel}</span>
        ) : null}
      </div>
    </div>
  );
}
