"use client";

import { useCallback, useRef, useState } from "react";
import { type FiringPage, type FiringRow, withOlderPage, withRefreshedPage } from "./firing-history";

export type OlderFiringsState = "idle" | "loading" | "failed";

export interface FiringHistory<T extends FiringRow> {
  /** Null until the first page arrives (and again after `reset`). */
  readonly history: FiringPage<T> | null;
  /** Why the newest page could not be read, or null. */
  readonly error: string | null;
  readonly older: OlderFiringsState;
  /** Read the newest page again: on open, and whenever the history changed. */
  readonly refresh: (signal?: AbortSignal) => Promise<void>;
  /** Append the next older page; a second call while one loads sends nothing. */
  readonly loadOlder: () => Promise<void>;
  /** Forget everything, for another automation or routine. A late answer for
   *  the one before is dropped. */
  readonly reset: () => void;
}

/**
 * A firing history read a page at a time, shared by the automation and bot
 * routine history drawers. `fetchPage` reads one page (`cursor` null for the
 * newest) and must keep its identity while the history it reads stays the same.
 */
export function useFiringHistory<T extends FiringRow>(
  fetchPage: (cursor: string | null, signal?: AbortSignal) => Promise<FiringPage<T>>,
): FiringHistory<T> {
  const [history, setHistory] = useState<FiringPage<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [older, setOlder] = useState<OlderFiringsState>("idle");
  // Read by a refresh that lands while an older page loads: once older rows
  // are shown, the refreshed page goes in front of them instead of replacing them.
  const olderLoaded = useRef(false);
  const olderInFlight = useRef(false);
  const generation = useRef(0);

  const reset = useCallback(() => {
    generation.current += 1;
    olderLoaded.current = false;
    olderInFlight.current = false;
    setHistory(null);
    setError(null);
    setOlder("idle");
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const asked = generation.current;
      try {
        const page = await fetchPage(null, signal);
        if (asked !== generation.current) return;
        setHistory((current) => withRefreshedPage(current, page, olderLoaded.current));
        setError(null);
      } catch (cause) {
        if (signal?.aborted || asked !== generation.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [fetchPage],
  );

  const cursor = history?.nextCursor ?? null;
  const loadOlder = useCallback(async () => {
    if (!cursor || olderInFlight.current) return;
    const asked = generation.current;
    olderInFlight.current = true;
    setOlder("loading");
    try {
      const page = await fetchPage(cursor);
      if (asked !== generation.current) return;
      olderLoaded.current = true;
      setHistory((current) => (current ? withOlderPage(current, page) : current));
      setOlder("idle");
    } catch {
      if (asked === generation.current) setOlder("failed");
    } finally {
      if (asked === generation.current) olderInFlight.current = false;
    }
  }, [cursor, fetchPage]);

  return { history, error, older, refresh, loadOlder, reset };
}
