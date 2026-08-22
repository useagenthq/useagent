"use client";

/**
 * A tiny external store for a tuning config, persisted to `localStorage`.
 *
 * Both the ray shader and the glass material need the same thing: a value
 * read during render, mutated by a panel, surviving reloads, and rendering as
 * committed defaults on the server. `useSyncExternalStore` wants a stable
 * snapshot identity, which is the only real subtlety here — the cache is what
 * stops React re-rendering forever.
 *
 * TEMPORARY, with the panels — see `tuning-panel.tsx`.
 */

export type TuningValues = Record<string, number | string>;

export type TuningStore<T extends TuningValues> = {
  subscribe: (listener: () => void) => () => void;
  get: () => T;
  getDefaults: () => T;
  update: (patch: Partial<T>) => void;
  reset: () => void;
};

export function createTuningStore<T extends TuningValues>(
  storageKey: string,
  defaults: T,
): TuningStore<T> {
  const listeners = new Set<() => void>();
  let cached: T | null = null;

  const load = (): T => {
    try {
      const stored = localStorage.getItem(storageKey);
      // Spread over the defaults so a config saved before a knob existed still
      // loads, rather than leaving that property undefined.
      if (stored) return { ...defaults, ...JSON.parse(stored) };
    } catch {
      // A stale or hand-edited value should not take the page down with it.
    }
    return defaults;
  };

  const emit = () => {
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get() {
      cached ??= load();
      return cached;
    },
    getDefaults: () => defaults,
    update(patch) {
      cached = { ...(cached ?? load()), ...patch };
      try {
        localStorage.setItem(storageKey, JSON.stringify(cached));
      } catch {
        // Private mode or a full quota — tuning still works for this session.
      }
      emit();
    },
    reset() {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // Nothing to clear; the in-memory reset below is what matters.
      }
      cached = defaults;
      emit();
    },
  };
}

/** The panel is a dev tool — plus `?shader` so a preview deploy can be tuned. */
let tuning: boolean | null = null;

export function isTuningEnabled(): boolean {
  tuning ??=
    process.env.NODE_ENV !== "production" ||
    new URLSearchParams(window.location.search).has("shader");
  return tuning;
}

export function isTuningEnabledOnServer(): boolean {
  return false;
}

export function subscribeToNothing() {
  return () => {};
}
