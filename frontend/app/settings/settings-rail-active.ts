/**
 * Scroll-spy selection rule for the settings rail, kept pure so the geometry
 * can be tested against measured layouts.
 *
 * A section is active once its top edge has crossed the activation line. The
 * line sits at 30% of the viewport while the page can still scroll, so a
 * section lights up as its heading nears the top. Once the scroller is at its
 * bottom the line drops to the viewport middle: on a short viewport the last
 * headings never climb into the upper band, and without this the section
 * whose tail is still on screen would keep the highlight forever.
 */

export type RailScrollFrame = {
  /** Section top edges in rail order, relative to the scroller's top edge. */
  sectionTops: readonly number[];
  viewportHeight: number;
  scrollTop: number;
  scrollHeight: number;
};

const ACTIVATION_RATIO = 0.3;
/** Fractional scroll positions can leave a scroller a pixel or two short of its end. */
const BOTTOM_SLACK_PX = 2;

export function activeSectionIndex({
  sectionTops,
  viewportHeight,
  scrollTop,
  scrollHeight,
}: RailScrollFrame): number {
  if (sectionTops.length === 0) return 0;
  const atBottom = scrollTop + viewportHeight >= scrollHeight - BOTTOM_SLACK_PX;
  // The final heading cannot always reach the activation line on short
  // viewports. Once the scroller reaches its end, the final section owns the
  // remaining content and must remain selectable by click or URL hash.
  if (atBottom) return sectionTops.length - 1;
  const line = viewportHeight * ACTIVATION_RATIO;
  return Math.max(
    sectionTops.findLastIndex((top) => top <= line),
    0,
  );
}
