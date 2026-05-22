"use client";

import { useCallback, useEffect, useState } from "react";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";
import { extractFleet, type FleetData } from "./fleet-data";
import { LimitsRow } from "./limits-row";

const POLL_MS = 15_000;

/**
 * Client wrapper for the Limits card (per-model token/cost burn + Daytona
 * footprint). GET /api/fleet has no SSR seed, so this fetches it on mount, on
 * every org run-change, and on a low-frequency recovery poll. A transient
 * failure keeps the last good snapshot rather than blanking the card.
 */
export function FleetLimits() {
  const [fleet, setFleet] = useState<FleetData | null>(null);

  const loadFleet = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await backendFetch("/api/fleet", { signal, cache: "no-store" });
      if (!res.ok) return;
      const parsed = extractFleet(await res.json());
      if (parsed) setFleet(parsed);
    } catch {
      // Transient failure — keep the last good snapshot.
    }
  }, []);

  useOrgChanges((change) => {
    if (change.type === "run") void loadFleet();
  });

  useEffect(() => {
    const ctrl = new AbortController();
    void loadFleet(ctrl.signal);
    const id = setInterval(() => void loadFleet(ctrl.signal), POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [loadFleet]);

  return <LimitsRow fleet={fleet} />;
}
