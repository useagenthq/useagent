"use client";

import { RiBroadcastLine } from "@remixicon/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as SegmentedControl from "@/components/ui/segmented-control";
import { backendFetch } from "@/lib/backend-fetch";
import { ArtifactCard } from "./artifact-card";
import {
  deriveArtifacts,
  extractRuns,
  type ArtifactCategory,
  type BackendRun,
} from "./derive";

type Filter = "all" | ArtifactCategory;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "code", label: "Files" },
  { id: "docs", label: "Docs" },
  { id: "media", label: "Media" },
];

/** Running runs may add file steps mid-run, so re-poll the list every 10s. */
const REFRESH_MS = 10_000;

function EmptyState() {
  return (
    <div className="mt-10 flex flex-col items-center justify-center rounded-2xl border border-dashed border-stroke-soft-200 bg-bg-weak-50 px-6 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border border-stroke-soft-200 bg-bg-white-0">
        <RiBroadcastLine aria-hidden className="size-6 text-text-soft-400" />
      </div>
      <h2 className="mt-4 text-title-h6 text-text-strong-950">No artifacts yet</h2>
      <p className="mt-1 max-w-sm text-paragraph-sm text-text-sub-600">
        Start a run and the files and outputs it produces will stream in here.
      </p>
      <Link
        href="/agent/new"
        className="mt-5 inline-flex h-9 items-center rounded-full bg-bg-strong-950 px-4 text-label-sm text-text-white-0 shadow-regular-xs outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2"
      >
        Start a run
      </Link>
    </div>
  );
}

/**
 * Live per-run output stream. Seeded from a server-fetched run list, then
 * re-polls `GET /api/runs` every 10s (running runs stream new file steps in).
 * Derives file-step artifacts newest-first and filters them client-side.
 */
export function LiveArtifacts({ initialRuns }: { initialRuns: BackendRun[] }) {
  const [runs, setRuns] = useState<BackendRun[]>(initialRuns);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await backendFetch("/api/runs", { signal, cache: "no-store" });
      if (!res.ok) return;
      const data: unknown = await res.json();
      setRuns(extractRuns(data) ?? []);
    } catch {
      // Transient failure — keep the last good snapshot.
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    const id = setInterval(() => void load(ctrl.signal), REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [load]);

  const artifacts = useMemo(() => deriveArtifacts(runs), [runs]);
  const visible = useMemo(
    () => (filter === "all" ? artifacts : artifacts.filter((a) => a.category === filter)),
    [artifacts, filter],
  );

  return (
    <div className="mx-auto w-full max-w-[1120px] px-6 py-8 sm:px-10 sm:py-10">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-2.5">
          <RiBroadcastLine aria-hidden className="mt-0.5 size-5 text-text-strong-950" />
          <div className="flex flex-col gap-0.5">
            <h1 className="text-display-sm text-text-strong-950">Live Artifacts</h1>
            <p className="text-paragraph-sm text-text-sub-600">
              Files and outputs streaming from agent runs
            </p>
          </div>
        </div>
        <SegmentedControl.Root
          value={filter}
          onValueChange={(value) => setFilter(value as Filter)}
        >
          <SegmentedControl.List aria-label="Filter artifacts" className="w-auto">
            {FILTERS.map(({ id, label }) => (
              <SegmentedControl.Trigger key={id} value={id} className="px-3">
                {label}
              </SegmentedControl.Trigger>
            ))}
          </SegmentedControl.List>
        </SegmentedControl.Root>
      </div>

      {/* Body */}
      {artifacts.length === 0 ? (
        <EmptyState />
      ) : visible.length > 0 ? (
        <div className="mt-8 grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      ) : (
        <p className="mt-10 text-paragraph-sm text-text-sub-600">
          No {FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} artifacts yet.
        </p>
      )}
    </div>
  );
}
