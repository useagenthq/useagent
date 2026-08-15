"use client";

import { useCallback, useEffect, useState } from "react";
import { BackendUnreachable } from "@/components/shared/backend-unreachable";
import { useOrgChanges } from "@/hooks/use-org-changes";
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
 * refreshed from the org invalidation stream with a low-frequency recovery
 * poll. Every figure is derived from live data: the
 * banner/lane math from GET /api/runs, and the Limits card (per-model token/cost
 * burn + Daytona footprint) from GET /api/fleet.
 */
export function WorkspaceView({
  initialRuns,
  initialError,
}: {
  initialRuns: WorkspaceRun[];
  initialError: boolean;
}) {
  const [runs, setRuns] = useState<WorkspaceRun[]>(initialRuns);
  const [fleet, setFleet] = useState<FleetData | null>(null);
  const [error, setError] = useState(initialError);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await backendFetch("/api/runs", { signal, cache: "no-store" });
      if (!res.ok) {
        setError(true);
        return;
      }
      setRuns(extractRuns(await res.json()));
      setError(false);
    } catch {
      // Backend unreachable — surface the distinct error banner. Any last good
      // snapshot stays rendered below it (honest: stale data + a clear signal
      // the refresh failed), rather than silently looking calm.
      if (!signal?.aborted) setError(true);
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

  useOrgChanges((change) => {
    if (change.type === "run") void load();
  });

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

        {error && <BackendUnreachable onRetry={() => void load()} />}

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
