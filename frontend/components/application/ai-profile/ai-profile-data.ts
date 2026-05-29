/**
 * Mock data for the AI contributions profile template (Figma node 4063:5675).
 *
 * Everything is deterministic (no Math.random/Date.now) so the server and
 * client render identically.
 */

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Bars track is 206px tall; the tallest design bar is 158px. */
export const AGENTS_TRACK_HEIGHT = 206;
export const AGENTS_MAX_BAR = 158;
/** Days with zero agents render a 4px grey stub (Figma node 4065:8629). */
export const AGENTS_ZERO_BAR = 4;

/**
 * December bar heights straight from Figma (nodes 4065:8622…8682), trimmed
 * to 30 bars — one per day. 0 = no agents that day.
 */
const DECEMBER_BARS = [
  73, 141, 118, 0, 118, 18, 0, 0, 0, 95,
  0, 158, 78, 45, 0, 45, 135, 88, 0, 0,
  107, 21, 45, 105, 87, 66, 19, 128, 98, 34,
];

/** Small bit-mixing hash — same recipe as the contributions heatmap. */
function hash(a: number, b: number) {
  let h = a * 374761393 + b * 668265263;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 30 daily bar heights (px) for a month; December is the Figma original. */
export function agentBarsFor(month: number): number[] {
  if (month === 11) return DECEMBER_BARS;
  return Array.from({ length: 30 }, (_, day) => {
    const seed = hash(month + 1, day + 7);
    // ~1 in 4 days idle, mirroring the December distribution.
    if (seed % 4 === 0) return 0;
    return 18 + (seed % (AGENTS_MAX_BAR - 18));
  });
}

/** Headline agent count per month — December matches the design's "32 agents". */
export function agentCountFor(month: number): number {
  if (month === 11) return 32;
  return 22 + (hash(month + 3, 17) % 27);
}

/**
 * Tokens line — 30 daily values (millions) from Jun 14 to today. Realistic
 * bursty usage: an early session that tails off into a long idle stretch
 * (days 3–11), one isolated spike, a quiet patch with small bumps, then the
 * month's big multi-day push, a cooldown, and a second medium run that eases
 * off at the end.
 */
export const TOKENS_SERIES = [
  34.2, 28.6, 6.1, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 31.4, 4.8, 2.2, 1.1, 5.6, 1.4, 0.8, 42.1,
  51.8, 48.3, 33.6, 9.2, 3.4, 18.7, 25.3, 37.9, 30.2, 24.6,
].map((value, i) => ({ day: i, value }));
