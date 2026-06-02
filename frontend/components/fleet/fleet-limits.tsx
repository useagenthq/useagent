"use client";

import { useCallback, useEffect, useState } from "react";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";
import {
  extractCapacity,
  extractFleet,
  type CapacityData,
  type FleetData,
} from "./fleet-data";
import { LimitsRow } from "./limits-row";

const POLL_MS = 15_000;

/**
 * Client wrapper for the Limits card (per-model token/cost burn + Daytona
 * footprint + fleet capacity / durable queue). The GET routes have no SSR seed,
 * so this fetches on mount, on every org run-change, and on a low-frequency
 * recovery poll. A transient failure keeps the last good snapshot.
 */
export function FleetLimits() {
  const [fleet, setFleet] = useState<FleetData | null>(null);
  const [capacity, setCapacity] = useState<CapacityData | null>(null);

  const loadFleet = useCallback(async (signal?: AbortSignal) => {
    try {
      const [fleetRes, capRes] = await Promise.all([
        backendFetch("/api/fleet", { signal, cache: "no-store" }),
        backendFetch("/api/fleet/capacity", { signal, cache: "no-store" }),
      ]);
      if (fleetRes.ok) {
        const parsed = extractFleet(await fleetRes.json());
        if (parsed) setFleet(parsed);
      }
      if (capRes.ok) {
        const parsed = extractCapacity(await capRes.json());
        if (parsed) setCapacity(parsed);
      }
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

  return <LimitsRow fleet={fleet} capacity={capacity} />;
}
