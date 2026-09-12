"use client";

// The ONE disclosure a bot thread folds its work behind: a quiet header line
// ("Worked for 3m 12s, 14 steps" / "Working, <step>") with a chevron, opening
// in place to the full interleaved timeline. Children render only while open,
// so a long work log never hits the DOM behind a closed fold. The open/closed
// choice is remembered per thread in localStorage (read after mount so the
// server and first client paint agree; every access is guarded).

import { RiArrowDownSLine, RiArrowRightSLine } from "@remixicon/react";
import type { ReactNode } from "react";
import { useTurnUiState } from "@/components/chat/turn-ui-state";

export function BotWorkFold({
  label,
  live,
  failed,
  children,
}: {
  label: string;
  live: boolean;
  failed: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useTurnUiState("bot-work", false);
  const Chevron = open ? RiArrowDownSLine : RiArrowRightSLine;

  return (
    <section data-testid="bot-work-fold" data-live={live ? "true" : undefined} aria-label={label}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`flex max-w-full cursor-pointer select-none items-center gap-1.5 rounded-md px-1 text-[12px] leading-5 tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring ${failed ? "text-text-error-primary hover:text-text-error-primary" : "text-text-secondary hover:text-text-primary"}`}
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
