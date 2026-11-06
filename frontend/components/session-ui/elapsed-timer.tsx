"use client";

// The thread's one self-ticking elapsed label (shared by the working line and
// the background status pill): renders the current elapsed text, then updates
// its own text node every second outside React commits, from the
// MessagesTimeline WorkingTimer pattern vendored with working-indicator.tsx.

import { useEffect, useRef } from "react";
import { formatWorkingTimerNow } from "./work-entry";

/** Self-ticking elapsed label; updates its own text node outside React commits. */
export function ElapsedTimer({ startedAt }: { startedAt: string }) {
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
