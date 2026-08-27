import { describe, expect, test } from "bun:test";
import {
  computeRealRows,
  computeWindowRange,
  estimateTurnHeight,
  mergeIslets,
  rowOffsets,
  scrollCorrection,
  selectAnchor,
  TURN_GAP_PX,
} from "./turn-window-model";

// Ten 200px rows with the standard gap: row i spans [i*232, i*232 + 200].
const HEIGHTS = Array.from({ length: 10 }, () => 200);

describe("rowOffsets", () => {
  test("accumulates heights plus the inter-row gap", () => {
    expect(rowOffsets([100, 50, 80], 32)).toEqual([0, 132, 214]);
  });

  test("empty input yields no offsets", () => {
    expect(rowOffsets([], 32)).toEqual([]);
  });
});

describe("computeWindowRange", () => {
  test("covers the viewport plus the overscan buffer on each side", () => {
    // Viewport [1000, 1500), buffer 750: window [250, 2250).
    const range = computeWindowRange(HEIGHTS, TURN_GAP_PX, 1000, 500);
    // Row 1 ends at 432 (> 250); row 9 starts at 2088 (< 2250).
    expect(range).toEqual({ start: 1, end: 9 });
  });

  test("clamps at the top of the transcript", () => {
    const range = computeWindowRange(HEIGHTS, TURN_GAP_PX, 0, 500, 1.5);
    expect(range.start).toBe(0);
    // Window bottom 1250: row 5 starts at 1160, row 6 at 1392.
    expect(range.end).toBe(5);
  });

  test("empty input yields an empty range", () => {
    const range = computeWindowRange([], TURN_GAP_PX, 0, 500);
    expect(range.end).toBeLessThan(range.start);
  });

  test("zero overscan windows exactly the viewport", () => {
    const range = computeWindowRange(HEIGHTS, TURN_GAP_PX, 464, 200, 0);
    // Viewport [464, 664): row 2 spans [464, 664), row 1 ends at 432.
    expect(range).toEqual({ start: 2, end: 2 });
  });
});

describe("mergeIslets", () => {
  test("materializes a placeholder run shorter than the viewport", () => {
    // Rows 2-3 are placeholders totalling 432px (< 500 viewport): both ends of
    // the run could be visible at once, so the run materializes whole.
    const real = [true, true, false, false, true, true];
    const merged = mergeIslets(real, [200, 200, 200, 200, 200, 200], TURN_GAP_PX, 500);
    expect(merged).toEqual([true, true, true, true, true, true]);
  });

  test("keeps a placeholder run taller than the viewport", () => {
    const real = [true, false, false, false, true];
    const merged = mergeIslets(real, [200, 300, 300, 300, 200], TURN_GAP_PX, 500);
    expect(merged).toEqual([true, false, false, false, true]);
  });

  test("applies at the edges of the transcript too", () => {
    const real = [false, true, true, false, false];
    const merged = mergeIslets(real, [100, 200, 200, 400, 400], TURN_GAP_PX, 500);
    // Leading single 100px run merges; trailing 832px run stays placeholder.
    expect(merged).toEqual([true, true, true, false, false]);
  });
});

describe("computeRealRows", () => {
  test("forces the tail real even when far outside the window", () => {
    const real = computeRealRows(HEIGHTS, TURN_GAP_PX, 0, 300, [9]);
    expect(real[9]).toBe(true);
    // Rows well past the buffer but before the tail stay placeholders.
    expect(real[6]).toBe(false);
  });

  test("forces live turns real wherever they sit", () => {
    const real = computeRealRows(HEIGHTS, TURN_GAP_PX, 2000, 300, [4, 9]);
    expect(real[4]).toBe(true);
  });

  test("window, forced rows, and islet merging compose", () => {
    // Window at the top, tail forced: the gap between them is ~1500px tall, so
    // it must NOT merge; shrink the gap to one row and it must.
    const tall = computeRealRows(HEIGHTS, TURN_GAP_PX, 0, 300, [9]);
    expect(tall.slice(4, 9)).toContain(false);
    const short = computeRealRows(HEIGHTS.slice(0, 5), TURN_GAP_PX, 0, 300, [4]);
    expect(short).toEqual([true, true, true, true, true]);
  });
});

describe("selectAnchor", () => {
  const rows = (real: readonly boolean[]) =>
    real.map((r, i) => ({ top: i * 232, height: 200, real: r }));

  test("picks the topmost visible real row", () => {
    // Viewport [300, 800): rows 1..3 intersect; row 1 is a placeholder.
    const anchor = selectAnchor(rows([true, false, true, true, true]), 300, 500);
    expect(anchor).toBe(2);
  });

  test("falls back to the topmost visible placeholder", () => {
    const anchor = selectAnchor(rows([true, false, false, false, true]), 300, 400);
    expect(anchor).toBe(1);
  });

  test("a row straddling the viewport top edge counts as visible", () => {
    // Row 0 spans [0, 200): still on screen at scrollTop 150.
    const anchor = selectAnchor(rows([true, true, true]), 150, 500);
    expect(anchor).toBe(0);
  });

  test("returns -1 when nothing intersects the viewport", () => {
    const anchor = selectAnchor(rows([true, true]), 5000, 500);
    expect(anchor).toBe(-1);
  });
});

describe("scrollCorrection", () => {
  test("sums only height deltas strictly above the anchor", () => {
    const changes = [
      { index: 0, delta: 40 },
      { index: 2, delta: -10 },
      { index: 5, delta: 100 },
    ];
    expect(scrollCorrection(changes, 5)).toBe(30);
    expect(scrollCorrection(changes, 3)).toBe(30);
    expect(scrollCorrection(changes, 1)).toBe(40);
  });

  test("changes at or below the anchor never move it", () => {
    expect(scrollCorrection([{ index: 4, delta: 500 }], 4)).toBe(0);
    expect(scrollCorrection([{ index: 6, delta: 500 }], 4)).toBe(0);
  });

  test("no anchor means no correction", () => {
    expect(scrollCorrection([{ index: 0, delta: 40 }], -1)).toBe(0);
  });
});

describe("estimateTurnHeight", () => {
  const turn = (steps: number, summary: string | null, status = "completed") => ({
    status,
    summary,
    steps: Array.from({ length: steps }, () => ({})),
  });

  test("queued turns are a bare bubble + pill", () => {
    expect(estimateTurnHeight(turn(0, null, "queued"))).toBeLessThan(
      estimateTurnHeight(turn(0, null)),
    );
  });

  test("grows with work rows but caps at the fold size", () => {
    const few = estimateTurnHeight(turn(2, null));
    const fold = estimateTurnHeight(turn(6, null));
    expect(few).toBeLessThan(fold);
    expect(estimateTurnHeight(turn(60, null))).toBe(fold);
  });

  test("answer contribution scales with summary length but caps", () => {
    const short = estimateTurnHeight(turn(0, "Done."));
    const long = estimateTurnHeight(turn(0, "x".repeat(500)));
    const huge = estimateTurnHeight(turn(0, "x".repeat(50_000)));
    expect(short).toBeLessThan(long);
    expect(estimateTurnHeight(turn(0, "x".repeat(5000)))).toBe(huge);
  });
});
