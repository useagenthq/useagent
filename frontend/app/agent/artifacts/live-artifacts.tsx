"use client";

import { RiBroadcastLine, RiRefreshLine } from "@remixicon/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  categoryForArtifact,
  extractArtifacts,
  type ArtifactCategory,
  type ArtifactDescriptor,
} from "@/components/artifacts/model";
import * as SegmentedControl from "@/components/ui/segmented-control";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";
import { ArtifactCard } from "./artifact-card";

type Filter = "all" | ArtifactCategory;

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "files", label: "Files" },
  { id: "docs", label: "Docs" },
  { id: "media", label: "Media" },
];

const REFRESH_MS = 5_000;

function EmptyState() {
  return (
    <div className="mt-10 flex flex-col items-center justify-center rounded-xl border border-dashed border-stroke-soft-200 bg-bg-weak-50 px-6 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-full border border-stroke-soft-200 bg-bg-white-0">
        <RiBroadcastLine aria-hidden className="size-5 text-text-soft-400" />
      </div>
      <h2 className="mt-4 text-title-h6 text-text-strong-950">No artifacts yet</h2>
      <p className="mt-1 max-w-sm text-paragraph-sm text-text-sub-600">
        Screenshots, reports, documents, and other files published by your agents will appear here.
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

function UnavailableState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mt-10 flex flex-col items-center justify-center rounded-xl border border-dashed border-stroke-soft-200 bg-bg-weak-50 px-6 py-16 text-center">
      <RiBroadcastLine aria-hidden className="size-6 text-text-soft-400" />
      <h2 className="mt-4 text-title-h6 text-text-strong-950">Artifacts are unavailable</h2>
      <p className="mt-1 max-w-sm text-paragraph-sm text-text-sub-600">
        The artifact service could not be reached. Your existing files are not deleted.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 inline-flex h-9 items-center rounded-full bg-bg-strong-950 px-4 text-label-sm text-text-white-0 shadow-regular-xs outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2"
      >
        Try again
      </button>
    </div>
  );
}

/** Durable artifact browser. Metadata refreshes independently of run history;
 * every card links to the authenticated content endpoint for its exact bytes. */
export function LiveArtifacts({
  initialArtifacts,
  initialAvailable,
}: {
  initialArtifacts: ArtifactDescriptor[];
  initialAvailable: boolean;
}) {
  const [artifacts, setArtifacts] = useState(initialArtifacts);
  const [available, setAvailable] = useState(initialAvailable);
  const [filter, setFilter] = useState<Filter>("all");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const response = await backendFetch("/api/artifacts", { signal, cache: "no-store" });
      if (!response.ok) {
        setAvailable(false);
        return;
      }
      const parsed = extractArtifacts(await response.json());
      if (parsed) {
        setArtifacts(parsed);
        setAvailable(true);
      } else {
        setAvailable(false);
      }
    } catch {
      // Keep the last known durable snapshot across transient reconnects.
      if (!signal?.aborted) setAvailable(false);
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, []);

  useOrgChanges((change) => {
    if (change.type === "artifact") void load();
  });

  useEffect(() => {
    const controller = new AbortController();
    const interval = setInterval(() => void load(controller.signal), REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [load]);

  const visible = useMemo(
    () =>
      filter === "all"
        ? artifacts
        : artifacts.filter((artifact) => categoryForArtifact(artifact) === filter),
    [artifacts, filter],
  );

  return (
    <div className="mx-auto w-full max-w-[1120px] px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-2.5">
          <RiBroadcastLine aria-hidden className="mt-0.5 size-5 text-text-strong-950" />
          <div className="flex flex-col gap-0.5">
            <h1 className="text-display-sm text-text-strong-950">Artifacts</h1>
            <p className="text-paragraph-sm text-text-sub-600">
              Durable files published by agent runs
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            aria-label="Refresh artifacts"
            title="Refresh"
            disabled={refreshing}
            className="flex size-9 items-center justify-center rounded-lg border border-stroke-soft-200 bg-bg-white-0 text-text-sub-600 outline-none hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 disabled:opacity-50"
          >
            <RiRefreshLine
              aria-hidden
              className={`size-4 ${refreshing ? "animate-spin" : ""}`}
            />
          </button>
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
      </div>

      {!available && artifacts.length > 0 && (
        <p role="status" className="mt-4 text-paragraph-xs text-text-soft-400">
          Reconnecting to the artifact service. Showing the last loaded files.
        </p>
      )}

      {!available && artifacts.length === 0 ? (
        <UnavailableState onRetry={() => void load()} />
      ) : artifacts.length === 0 ? (
        <EmptyState />
      ) : visible.length > 0 ? (
        <div className="mt-8 grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      ) : (
        <p className="mt-10 text-paragraph-sm text-text-sub-600">
          No {FILTERS.find((item) => item.id === filter)?.label.toLowerCase()} artifacts yet.
        </p>
      )}
    </div>
  );
}
