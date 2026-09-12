"use client";

import { useEffect, useState } from "react";
import { type CapabilityCatalog, fetchCapabilityCatalog } from "@/lib/capability-catalog";

export const CAPABILITY_CATALOG_RETRY_DELAYS_MS = [
  1_000, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
] as const;

type CapabilityCatalogTimer = ReturnType<typeof setTimeout> | number;

interface CapabilityCatalogPollDependencies {
  readonly fetchCatalog?: () => Promise<CapabilityCatalog | null>;
  readonly setTimer?: (callback: () => void, delayMs: number) => CapabilityCatalogTimer;
  readonly clearTimer?: (timer: CapabilityCatalogTimer) => void;
}

export function pollCapabilityCatalog(
  publish: (state: { catalog: CapabilityCatalog | null; loaded: boolean }) => void,
  dependencies: CapabilityCatalogPollDependencies = {},
): () => void {
  const fetchCatalog = dependencies.fetchCatalog ?? fetchCapabilityCatalog;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  let cancelled = false;
  let timer: CapabilityCatalogTimer | undefined;

  const load = async (attempt: number) => {
    const catalog = await fetchCatalog();
    if (cancelled) return;
    publish({ catalog, loaded: true });
    const codexCatalog = catalog?.engines.find((engine) => engine.id === "codex")?.modelCatalog;
    const delay = CAPABILITY_CATALOG_RETRY_DELAYS_MS[attempt];
    if (codexCatalog?.stale && delay !== undefined) {
      timer = setTimer(() => {
        timer = undefined;
        void load(attempt + 1);
      }, delay);
    }
  };

  void load(0);
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimer(timer);
  };
}

export function useCapabilityCatalog(): {
  catalog: CapabilityCatalog | null;
  loaded: boolean;
} {
  const [state, setState] = useState<{ catalog: CapabilityCatalog | null; loaded: boolean }>({
    catalog: null,
    loaded: false,
  });
  useEffect(() => {
    return pollCapabilityCatalog(setState);
  }, []);
  return state;
}
