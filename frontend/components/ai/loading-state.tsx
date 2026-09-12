"use client";

import { cx } from "@/utils/cx";

/**
 * The 3x3 pixel grid that stands for long-running work, ported from the
 * beautiful-ui LoadingState demo (all three of its patterns) onto the
 * foundation's `.ai-loading-pixel` pulse and our tokens:
 *
 *   drive  square cells, a chevron wavefront driving right; the 650ms cycle is
 *          shorter than the sweep, so two fronts are always in flight
 *   dots   the same wavefront on round cells
 *   orbit  a comet lapping the grid perimeter; the center cell stays dark
 *
 * Reduced motion freezes every pattern to its dim resting state (globals.css).
 */
export type LoadingPattern = "drive" | "dots" | "orbit";

/** The product-wide pattern: the trace header, live step rows and every
 *  `LoadingState` read this one constant. */
export const DEFAULT_LOADING_PATTERN: LoadingPattern = "dots";

export const LOADING_PATTERNS: readonly LoadingPattern[] = ["drive", "dots", "orbit"];

/** Chevron wavefront: each cell lights (column + distance from the middle row)
 *  steps after the front enters. */
const CHEVRON_DELAYS: readonly number[] = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3);
  const column = i % 3;
  return (column + Math.abs(row - 1)) * 90;
});

/** Perimeter order for the orbit comet; the center cell (4) never lights. */
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const ORBIT_DELAYS: readonly (number | null)[] = Array.from({ length: 9 }, (_, i) => {
  const lap = ORBIT_ORDER.indexOf(i);
  return lap === -1 ? null : lap * 110;
});

const PATTERNS: Record<
  LoadingPattern,
  { delays: readonly (number | null)[]; durationMs: number; round: boolean }
> = {
  drive: { delays: CHEVRON_DELAYS, durationMs: 650, round: false },
  dots: { delays: CHEVRON_DELAYS, durationMs: 650, round: true },
  orbit: { delays: ORBIT_DELAYS, durationMs: 950, round: false },
};

export interface PixelLoaderProps {
  pattern?: LoadingPattern;
  /** `md` is the 16px header glyph; `sm` is a 14px inline glyph for a step row. */
  size?: "md" | "sm";
  /** Sets the cell color (cells paint `currentColor`). */
  className?: string;
}

/** The bare pixel grid. Cells paint the current text color, so callers tone it
 *  with a text token; the default reads as a primary icon. */
export function PixelLoader({
  pattern = DEFAULT_LOADING_PATTERN,
  size = "md",
  className,
}: PixelLoaderProps) {
  const { delays, durationMs, round } = PATTERNS[pattern];
  return (
    <span
      aria-hidden
      data-pattern={pattern}
      className={cx(
        "grid shrink-0 grid-cols-[repeat(3,4px)] text-foreground-icon-primary",
        size === "md" ? "gap-[2px]" : "gap-px",
        className,
      )}
    >
      {delays.map((delay, index) => (
        <span
          key={index}
          className={cx(
            "size-1 bg-current",
            round ? "rounded-full" : "rounded-[1px]",
            delay === null ? "opacity-[0.07]" : "ai-loading-pixel",
          )}
          style={
            delay === null
              ? undefined
              : { animationDelay: `${delay}ms`, animationDuration: `${durationMs}ms` }
          }
        />
      ))}
    </span>
  );
}

export interface LoadingStateProps {
  label?: string;
  pattern?: LoadingPattern;
  className?: string;
}

/** Compact loading treatment: the pixel grid beside a shimmering label. */
export function LoadingState({ label = "Working", pattern, className }: LoadingStateProps) {
  return (
    <div className={cx("flex w-fit items-center gap-2.5", className)}>
      <PixelLoader pattern={pattern} />
      <span className="agent-progress-loading-text text-body-2-medium">{label}</span>
    </div>
  );
}
