import { useEffect, useSyncExternalStore } from 'react';

/**
 * Global "is anything working right now" signal - a tiny ref-counted store, no
 * polling and no cross-component prop threading. Any component that renders only
 * while work is happening (the OrbPill working/boot capsules) reports itself via
 * useReportWorking() for its lifetime; the brand mark in the top nav reads the
 * aggregate via useWorkingSignal() and pulses inward while the count is > 0.
 */
let count = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Count this component as "working" for its mounted lifetime (when `active`).
 *  Ref-counted, so overlapping reporters keep the signal on until the last one
 *  unmounts. */
export function useReportWorking(active = true): void {
  useEffect(() => {
    if (!active) return;
    count += 1;
    emit();
    return () => {
      count -= 1;
      emit();
    };
  }, [active]);
}

/** True while at least one reporter is active - drives the brand-mark pulse. */
export function useWorkingSignal(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => count > 0,
    () => false, // SSR: nothing is working during render
  );
}
