export interface SlidingInactivityWatchdog {
  /** Record genuine run activity and extend the silence deadline. */
  touch(): void;
  /** Permanently stop the timer. Safe to call more than once. */
  dispose(): void;
}

/** One low-cost sliding timer shared by every outer run activity source. */
export function createSlidingInactivityWatchdog(
  timeoutMs: number,
  onTimeout: () => void,
): SlidingInactivityWatchdog {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (disposed) return;
      disposed = true;
      onTimeout();
    }, timeoutMs);
  };
  arm();
  return {
    touch() {
      if (!disposed) arm();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
  };
}
