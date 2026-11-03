// The operator time limits on a turn and the words a turn ends with when one
// of them stops it. ENGINE_TIMEOUT_MS is the silence window (every step, delta
// and native frame starts it again); ENGINE_MAX_MS is the absolute ceiling,
// however active the turn is. Both are off unless an operator sets them.

/** The longest delay a timer honours. Bun fires a longer one after 1 ms, so a
 * larger setting is capped here instead of ending the turn at once. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface TurnTimeLimits {
  /** ENGINE_TIMEOUT_MS: the silence window, or Infinity when off. */
  readonly silenceMs: number;
  /** ENGINE_MAX_MS: the absolute ceiling, or Infinity when off. */
  readonly ceilingMs: number;
}

/** Unset, empty, not a number or not above zero means off (Infinity). */
function limitMs(raw: string | undefined): number {
  const parsed = Number(raw?.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return Number.POSITIVE_INFINITY;
  return Math.min(parsed, MAX_TIMER_DELAY_MS);
}

export function readTurnTimeLimits(
  env: Readonly<Record<string, string | undefined>>,
): TurnTimeLimits {
  return {
    silenceMs: limitMs(env.ENGINE_TIMEOUT_MS),
    ceilingMs: limitMs(env.ENGINE_MAX_MS),
  };
}

/** The done-step label and run summary for a turn stopped by the limit of
 * `firedMs`, the one that actually fired. An unknown limit is left unnamed. */
export function turnTimeoutText(
  firedMs: number | null,
): { readonly label: string; readonly summary: string } {
  if (firedMs === null || !Number.isFinite(firedMs)) {
    return { label: "Timed out", summary: "timed out" };
  }
  const after = `after ${firedMs / 1000}s`;
  return { label: `Timed out ${after}`, summary: `timed out ${after}` };
}
