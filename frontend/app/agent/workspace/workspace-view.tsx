"use client";

import { useCallback, useEffect, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";
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
 * refreshed client-side every 15s. All banner/lane math is derived live from
 * real run data; the meter/machine figures in LimitsRow are mock.
 */
export function WorkspaceView({ initialRuns }: { initialRuns: WorkspaceRun[] }) {
  const [runs, setRuns] = useState<WorkspaceRun[]>(initialRuns);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await backendFetch("/api/runs", { signal, cache: "no-store" });
      if (!res.ok) return;
      setRuns(extractRuns(await res.json()));
    } catch {
      // Transient failure — keep the last good snapshot.
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    const id = setInterval(() => void load(ctrl.signal), POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [load]);

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
          <LimitsRow runCount={stats.total} />
        </section>

        <section className="space-y-4">
          <h2 className="text-title-h6 text-text-strong-950">Fleet</h2>
          <Fleet lanes={lanes} stats={stats} />
        </section>
      </div>
    </div>
  );
}
