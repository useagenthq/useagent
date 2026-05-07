"use client";

import { useCallback, useEffect, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import { extractFleet, type FleetData } from "./fleet-data";
import { Fleet } from "./fleet";
import { LimitsRow } from "./limits-row";
import { StatusBanner } from "./status-banner";
import {
  computeStats,
  extractRuns,
  groupIntoLanes,
  type WorkspaceRun,
} from "./workspace-data";

const POLL_MS = 15_000;

/**
 * Fleet overview. Server-rendered from an initial GET /api/runs snapshot, then
 * refreshed client-side every 15s. Every figure is derived from live data: the
 * banner/lane math from GET /api/runs, and the Limits card (per-model token/cost
 * burn + Daytona footprint) from GET /api/fleet.
 */
export function WorkspaceView({ initialRuns }: { initialRuns: WorkspaceRun[] }) {
  const [runs, setRuns] = useState<WorkspaceRun[]>(initialRuns);
  const [fleet, setFleet] = useState<FleetData | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await backendFetch("/api/runs", { signal, cache: "no-store" });
      if (!res.ok) return;
      setRuns(extractRuns(await res.json()));
    } catch {
      // Transient failure — keep the last good snapshot.
    }
  }, []);

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

  useEffect(() => {
    const ctrl = new AbortController();
    // Fleet has no SSR seed — fetch it immediately, then refresh on the poll.
    void loadFleet(ctrl.signal);
    const id = setInterval(() => {
      void load(ctrl.signal);
      void loadFleet(ctrl.signal);
    }, POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [load, loadFleet]);

  const stats = computeStats(runs);
  const lanes = groupIntoLanes(runs);

  return (
    <div className="min-h-full bg-bg-weak-50">
      <div className="mx-auto w-full max-w-5xl space-y-8 p-6 lg:p-10">
        <header>
          <h1 className="text-display-md text-text-strong-950">Workspace</h1>
          <p className="mt-2 text-paragraph-sm text-text-sub-600">
            Mission control for your agent fleet.
          </p>
        </header>

        <StatusBanner stats={stats} />

        <section className="space-y-4">
          <h2 className="text-title-h6 text-text-strong-950">Limits</h2>
          <LimitsRow fleet={fleet} />
        </section>

        <section className="space-y-4">
          <h2 className="text-title-h6 text-text-strong-950">Fleet</h2>
          <Fleet lanes={lanes} stats={stats} />
        </section>
      </div>
    </div>
  );
}
