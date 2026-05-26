import type { RuntimeActivity } from "./runtime-orchestration";

/**
 * A provider retry storm (for example a broken provider gateway answering 500)
 * projects only `runtime.warning` activities at exponentially increasing
 * intervals while the T3 turn stays "running" forever. This watchdog bounds
 * that state: past a wall-clock no-progress timeout or a consecutive
 * retry-warning count, the turn must terminate as failed with the provider's
 * real underlying reason, never silently switch models, and never resend a
 * steer. `waitForRuntimeTurn` in t3-adapter.ts is the single owner.
 */
export const MAX_CONSECUTIVE_RETRY_WARNINGS = 8;

export class NoProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProgressError";
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

/** Surface the provider's real failure reason (for example the gateway HTTP
 * status message) instead of a generic Working state. */
export function retryWarningReason(activity: RuntimeActivity): string {
  const payload = asRecord(activity.payload);
  const detail = asRecord(payload?.detail);
  const attempt = typeof detail?.attempt === "number" ? detail.attempt : null;
  const message =
    typeof payload?.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : activity.summary.trim() || "provider retry warning";
  return attempt === null ? message : `retry attempt ${attempt}: ${message}`;
}

export interface NoProgressWatchdog {
  /** Aborted with a NoProgressError when the no-progress timeout elapses,
   * so the owning turn stream closes and surfaces that reason. */
  readonly signal: AbortSignal;
  /** Throws NoProgressError when consecutive retry warnings hit the bound;
   * any other activity kind counts as real progress. */
  observeActivity(activity: RuntimeActivity): void;
  /** Real progress (assistant text) resets both bounds. */
  observeProgress(): void;
  dispose(): void;
}

export function createNoProgressWatchdog(
  timeoutMs: number,
  sanitize: (text: string) => string = (text) => text,
  maxConsecutiveRetryWarnings: number = MAX_CONSECUTIVE_RETRY_WARNINGS,
): NoProgressWatchdog {
  const controller = new AbortController();
  let consecutiveRetryWarnings = 0;
  let latestReason: string | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const noProgressError = (bound: string): NoProgressError =>
    new NoProgressError(
      `Provider made no progress (${bound}): ${latestReason ?? "no provider activity"}`,
    );
  const settle = () => {
    disposed = true;
    clearTimeout(timer);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const error = noProgressError(
        `${consecutiveRetryWarnings} retry warnings in ${timeoutMs}ms`,
      );
      settle();
      controller.abort(error);
    }, timeoutMs);
  };
  const observeProgress = () => {
    if (disposed) return;
    consecutiveRetryWarnings = 0;
    latestReason = null;
    arm();
  };
  arm();

  return {
    signal: controller.signal,
    observeActivity(activity) {
      if (disposed) return;
      if (activity.kind !== "runtime.warning") {
        observeProgress();
        return;
      }
      latestReason = sanitize(retryWarningReason(activity));
      consecutiveRetryWarnings += 1;
      if (consecutiveRetryWarnings >= maxConsecutiveRetryWarnings) {
        const error = noProgressError(
          `${consecutiveRetryWarnings} consecutive retry warnings`,
        );
        settle();
        throw error;
      }
    },
    observeProgress,
    dispose: settle,
  };
}
