/**
 * Shared mock-activity data for the medical profile template — the Most
 * active days calendar and the Activity rings card both read from here so
 * a day's mini rings and the big Activity chart always show the same
 * fractions when that day is selected.
 */

export const YEAR = 2026;

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Same small hash-combine technique used elsewhere in this codebase
 *  (`calendar-data.ts`'s `hashString`, `ContributionsCard`'s `hashCell`) —
 *  deterministic per (month, day, ring) so values are stable across
 *  renders/SSR instead of using `Math.random`. */
function hash(seed: number) {
  let h = Math.imul(seed ^ 0x9e3779b9, 2654435761);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Ring fill fraction for a given day. Ring 0 = Move (pink), 1 = Exercise
 *  (lime), 2 = Running (sky).
 *
 *  Move is squared to skew the distribution toward low/mid values — a
 *  uniform 0.3–1.0 made almost every day's pink ring look nearly closed.
 *  Nothing ever reaches 1.0 (both formulas cap at ~0.95), matching the
 *  "no ring is ever fully completed" rule.
 */
export function ringPct(month: number, day: number, ring: number) {
  const h = hash(month * 1000 + day * 10 + ring);
  if (ring === 0) return 0.18 + h * h * 0.77;
  return 0.3 + h * 0.66;
}

function formatDuration(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export interface DayActivity {
  move: { pct: number; value: string };
  exercise: { pct: number; value: string };
  running: { pct: number; value: string };
}

/** Mocked-but-deterministic stats for one day, derived from the same ring
 *  fractions the calendar's mini rings draw. */
export function dayActivity(month: number, day: number): DayActivity {
  const movePct = ringPct(month, day, 0);
  const exercisePct = ringPct(month, day, 1);
  const runningPct = ringPct(month, day, 2);
  return {
    move: { pct: movePct, value: `${Math.round(500 + movePct * 1500).toLocaleString()} kcal` },
    exercise: { pct: exercisePct, value: formatDuration(Math.round(20 + exercisePct * 130)) },
    running: { pct: runningPct, value: `${(1 + runningPct * 5.5).toFixed(1)} km` },
  };
}

export interface SelectedDay {
  month: number;
  day: number;
}
