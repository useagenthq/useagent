"use client";

// The ONE disclosure a bot thread folds its work behind: a quiet header line
// ("Worked for 3m 12s, 14 steps" / "Working, <step>") with a chevron, opening
// in place to the full interleaved timeline. Children render only while open,
// so a long work log never hits the DOM behind a closed fold. The open/closed
// choice is remembered per thread in localStorage (read after mount so the
// server and first client paint agree; every access is guarded).

import { RiArrowDownSLine, RiArrowRightSLine } from "@remixicon/react";
import { type ReactNode, useEffect, useState } from "react";

const STORAGE_PREFIX = "useagent.bot-work-fold:";

function readFoldPreference(threadId: string): boolean | null {
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + threadId);
    return stored === null ? null : stored === "1";
  } catch {
    return null;
  }
}

function writeFoldPreference(threadId: string, open: boolean): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + threadId, open ? "1" : "0");
  } catch {
    /* storage unavailable (private mode, quota, SSR) - the choice just does not persist */
  }
}

export function BotWorkFold({
  threadId,
  label,
  live,
  children,
}: {
  threadId: string;
  label: string;
  live: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const stored = readFoldPreference(threadId);
    if (stored !== null) setOpen(stored);
  }, [threadId]);
  const toggle = () => {
    const next = !open;
    writeFoldPreference(threadId, next);
    setOpen(next);
  };
  const Chevron = open ? RiArrowDownSLine : RiArrowRightSLine;

  return (
    <section data-testid="bot-work-fold" data-live={live ? "true" : undefined} aria-label={label}>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex max-w-full cursor-pointer select-none items-center gap-1.5 rounded-md px-1 text-[12px] leading-5 text-text-secondary tabular-nums transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
      >
        {live && (
          <span className="ai-loading-pixel size-1.5 shrink-0 rounded-full bg-blue-500" aria-hidden />
        )}
        <span className="min-w-0 truncate">{label}</span>
        <Chevron className="size-3.5 shrink-0" aria-hidden />
      </button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}
