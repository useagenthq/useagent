/**
 * Scroll-spy selection rule for the settings rail, kept pure so the geometry
 * can be tested against measured layouts.
 *
 * A section is active once its top edge has crossed the activation line. The
 * line sits at 30% of the viewport, so a section lights up as its heading
 * nears the top. The settings stack reserves the remaining 70% of a viewport
 * after its content so every final heading can physically cross that line.
 */

export type RailScrollFrame = {
  /** Section top edges in rail order, relative to the scroller's top edge. */
  sectionTops: readonly number[];
  viewportHeight: number;
};

export const SETTINGS_ACTIVATION_RATIO = 0.3;
export const SETTINGS_SCROLL_TAIL_RATIO = 1 - SETTINGS_ACTIVATION_RATIO;

export function activeSectionIndex({ sectionTops, viewportHeight }: RailScrollFrame): number {
  if (sectionTops.length === 0) return 0;
  const line = viewportHeight * SETTINGS_ACTIVATION_RATIO;
  return Math.max(
    sectionTops.findLastIndex((top) => top <= line),
    0,
  );
}
