"use client";

import { RiFileList2Line, RiRefreshLine } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import { ArtifactCard } from "@/app/agent/artifacts/artifact-card";
import { type ArtifactDescriptor, extractArtifacts } from "@/components/artifacts/model";
import * as Button from "@/components/ui/button";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";
import { artifactQueryForThread } from "./artifacts-rail-model";

const LIVE_REFRESH_MS = 5_000;

export function ArtifactsRail({
  threadId,
  live,
}: {
  readonly threadId: string;
  readonly live: boolean;
}) {
  const [artifacts, setArtifacts] = useState<ArtifactDescriptor[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setRefreshing(true);
      try {
        const response = await backendFetch(artifactQueryForThread(threadId), {
          cache: "no-store",
          signal,
        });
        if (!response.ok) throw new Error(`artifact request failed (${response.status})`);
        const parsed = extractArtifacts(await response.json());
        if (!parsed) throw new Error("artifact response was invalid");
        setArtifacts(parsed);
        setAvailable(true);
      } catch {
        if (!signal?.aborted) setAvailable(false);
      } finally {
        if (!signal?.aborted) setRefreshing(false);
      }
    },
    [threadId],
  );

  useOrgChanges((change) => {
    if (change.type === "artifact" && change.threadId === threadId) void load();
  });

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    if (!live) return () => controller.abort();
    const interval = setInterval(() => void load(controller.signal), LIVE_REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [live, load]);

  return (
    <div className="absolute inset-0 overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-label-sm text-text-strong-950">Session files</p>
          <p className="text-paragraph-xs text-text-soft-400">
            Durable outputs you can preview, edit, or download
          </p>
        </div>
        <Button.Root
          variant="neutral"
          mode="stroke"
          size="xsmall"
          onClick={() => void load()}
          disabled={refreshing}
          aria-label="Refresh session files"
          title="Refresh"
          className="size-8 shrink-0 p-0"
        >
          <RiRefreshLine className={refreshing ? "size-4 animate-spin" : "size-4"} aria-hidden />
        </Button.Root>
      </div>

      {available === false && artifacts.length === 0 ? (
        <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-stroke-soft-200 bg-bg-weak-50 px-5 text-center">
          <RiFileList2Line className="size-5 text-text-soft-400" aria-hidden />
          <p className="mt-3 text-label-sm text-text-strong-950">Files unavailable</p>
          <p className="mt-1 text-paragraph-xs text-text-sub-600">Refresh to reconnect.</p>
        </div>
      ) : artifacts.length === 0 ? (
        <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-stroke-soft-200 bg-bg-weak-50 px-5 text-center">
          <RiFileList2Line className="size-5 text-text-soft-400" aria-hidden />
          <p className="mt-3 text-label-sm text-text-strong-950">
            {available === null ? "Loading files..." : "No files yet"}
          </p>
          <p className="mt-1 text-paragraph-xs text-text-sub-600">
            Agent-published documents and spreadsheets appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      )}
    </div>
  );
}
