"use client";

import { cx } from "@/utils/cx";

export interface LoadingStateProps {
  label?: string;
  className?: string;
}

/** Staggered per-dot delays (ms) for the 3×3 pixel matrix. */
const DOT_DELAYS = [90, 180, 270, 0, 90, 180, 90, 180, 270];

/**
 * Compact loading treatment: a pulsing pixel-dot matrix beside a shimmering
 * label. Ported from the beautiful-ui LoadingState demo ("Drive" variant) onto
 * our tokens + the foundation's `.ai-loading-pixel` /
 * `.agent-progress-loading-text` motion utilities.
 */
export function LoadingState({ label = "Working", className }: LoadingStateProps) {
  return (
    <div className={cx("flex w-fit items-center gap-2.5", className)}>
      <span aria-hidden className="grid grid-cols-3 gap-[2px]">
        {DOT_DELAYS.map((delay, index) => (
          <span
            key={index}
            className="ai-loading-pixel size-1 rounded-[1px] bg-foreground-icon-primary"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      <span className="agent-progress-loading-text text-body-2-medium">{label}</span>
    </div>
  );
}
