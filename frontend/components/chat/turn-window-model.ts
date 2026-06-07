// Turn-level render windowing for the session transcript - the PURE geometry.
// The component half (turn-window.tsx) feeds these functions from a
// measured-height cache and applies the results to the DOM; keeping the math
// here keeps every windowing decision (which rows are real, where the scroll
// anchor sits, how a height change corrects scrollTop) testable without a DOM.

/** Threads at or under this many top-level turns render fully - the window
 *  machinery adds nothing there and must not change behavior. */
export const SHORT_TRANSCRIPT_LIMIT = 30;

/** Real DOM extends this many viewport heights beyond each viewport edge. */
export const OVERSCAN_VIEWPORTS = 1.5;

/** Vertical gap between turn rows: the scroller's `space-y-8` (2rem). */
export const TURN_GAP_PX = 32;

export type WindowRange = { readonly start: number; readonly end: number };

/** Top offset of each row given row heights and the inter-row gap. */
export function rowOffsets(heights: readonly number[], gap: number): number[] {
  const offsets = new Array<number>(heights.length);
  let top = 0;
  for (let i = 0; i < heights.length; i++) {
    offsets[i] = top;
    top += heights[i] + gap;
  }
  return offsets;
}

/** Inclusive index range of rows intersecting the viewport padded by
 *  `overscan` viewport heights on each side. Empty input (or a window past
 *  every row) yields an empty range (start > end). */
export function computeWindowRange(
  heights: readonly number[],
  gap: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number = OVERSCAN_VIEWPORTS,
): WindowRange {
  const buffer = viewportHeight * overscan;
  const windowTop = scrollTop - buffer;
  const windowBottom = scrollTop + viewportHeight + buffer;
  let top = 0;
  let start = -1;
  let end = -2;
  for (let i = 0; i < heights.length; i++) {
    const bottom = top + heights[i];
    if (bottom > windowTop && top < windowBottom) {
      if (start === -1) start = i;
      end = i;
    }
    if (top >= windowBottom) break;
    top = bottom + gap;
  }
  return start === -1 ? { start: 0, end: -1 } : { start, end };
}

/** Islet rule: a contiguous run of placeholders short enough that both of its
 *  edges could be on screen at once (total height under one viewport) is
 *  materialized whole - a half-real seam there would show blank space. */
export function mergeIslets(
  real: readonly boolean[],
  heights: readonly number[],
  gap: number,
  viewportHeight: number,
): boolean[] {
  const out = [...real];
  let i = 0;
  while (i < out.length) {
    if (out[i]) {
      i += 1;
      continue;
    }
    let j = i;
    let groupHeight = 0;
    while (j < out.length && !out[j]) {
      groupHeight += heights[j] + (j > i ? gap : 0);
      j += 1;
    }
    if (groupHeight < viewportHeight) {
      for (let k = i; k < j; k++) out[k] = true;
    }
    i = j;
  }
  return out;
}

/** The full real-row decision for one frame: the overscanned viewport window,
 *  plus forced rows (live turns and the tail are always real), plus islet
 *  merging so no small placeholder run survives between real regions. */
export function computeRealRows(
  heights: readonly number[],
  gap: number,
  scrollTop: number,
  viewportHeight: number,
  forced: readonly number[],
): boolean[] {
  const { start, end } = computeWindowRange(heights, gap, scrollTop, viewportHeight);
  const real = heights.map((_, i) => i >= start && i <= end);
  for (const i of forced) {
    if (i >= 0 && i < real.length) real[i] = true;
  }
  return mergeIslets(real, heights, gap, viewportHeight);
}

export type AnchorRow = {
  readonly top: number;
  readonly height: number;
  readonly real: boolean;
};

/** Select the anchor from the layout that exists BEFORE pending measurements
 * are applied. Capturing this first is essential: a row above the viewport can
 * expand far enough to intersect it, but it must not replace the reader's
 * original anchor for the correction calculation. */
export function selectAnchorFromLayout(
  heights: readonly number[],
  real: ReadonlySet<number>,
  gap: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const offsets = rowOffsets(heights, gap);
  return selectAnchor(
    heights.map((height, index) => ({
      top: offsets[index],
      height,
      real: real.has(index),
    })),
    scrollTop,
    viewportHeight,
  );
}

/** The row whose viewport position must hold still when heights above it
 *  change: the topmost visible REAL row, else the topmost visible placeholder.
 *  Returns the row index, or -1 when nothing intersects the viewport. */
export function selectAnchor(
  rows: readonly AnchorRow[],
  scrollTop: number,
  viewportHeight: number,
): number {
  const viewBottom = scrollTop + viewportHeight;
  let placeholder = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.top + row.height <= scrollTop || row.top >= viewBottom) continue;
    if (row.real) return i;
    if (placeholder === -1) placeholder = i;
  }
  return placeholder;
}

export type HeightChange = { readonly index: number; readonly delta: number };

/** ScrollTop correction that keeps the anchor row visually fixed after the
 *  given row-height changes: only rows strictly above the anchor move it. */
export function scrollCorrection(
  changes: readonly HeightChange[],
  anchorIndex: number,
): number {
  if (anchorIndex < 0) return 0;
  let delta = 0;
  for (const change of changes) {
    if (change.index < anchorIndex) delta += change.delta;
  }
  return delta;
}

/** Placeholder height for a turn that has never been measured, from its shape:
 *  a queued turn is a bare bubble + pill; otherwise bubble + header + a capped
 *  contribution per visible work row (settled work folds) + answer length. */
export function estimateTurnHeight(turn: {
  readonly status: string;
  readonly summary: string | null;
  readonly steps: readonly unknown[];
}): number {
  if (turn.status === "queued") return 96;
  const work = Math.min(turn.steps.length, 6) * 36;
  const answer = turn.summary ? Math.min(120 + Math.round(turn.summary.length * 0.4), 480) : 40;
  return 150 + work + answer;
}

/** Nominal answer length for a not-yet-loaded turn that HAS a summary: the
 *  outline carries only a flag, so the placeholder assumes a typical answer and
 *  the measured height replaces the estimate once the turn's island loads. */
const OUTLINE_NOMINAL_SUMMARY = "x".repeat(250);

/** Placeholder height for a turn known only by its OUTLINE skeleton (windowed
 *  initial loading): the same shape estimate as estimateTurnHeight, fed the
 *  outline's step count and has-summary flag instead of real steps/summary. */
export function estimateOutlineHeight(
  status: string,
  outline: { readonly stepCount: number; readonly hasSummary: boolean },
): number {
  return estimateTurnHeight({
    status,
    summary: outline.hasSummary ? OUTLINE_NOMINAL_SUMMARY : null,
    steps: new Array<unknown>(Math.max(0, outline.stepCount)),
  });
}
