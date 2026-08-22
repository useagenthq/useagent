"use client";

import { RiFileList2Line, RiRefreshLine } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import { ArtifactCard } from "@/app/agent/artifacts/artifact-card";
import { type ArtifactDescriptor, extractArtifacts } from "@/components/artifacts/model";
import { IconButton } from "@/components/base/buttons/icon-button";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";
import { cx } from "@/utils/cx";
import { artifactQueryForThread } from "./artifacts-rail-model";

const LIVE_REFRESH_MS = 5_000;

/** Refresh glyph in its in-flight state; IconButton sizes it like any icon. */
function SpinningRefreshIcon({
  className,
  ...props
}: {
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}) {
  return <RiRefreshLine {...props} className={cx("animate-spin", className)} />;
}

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
          <p className="text-body-2-medium text-text-primary">Session files</p>
          <p className="text-caption-1-regular text-text-tertiary">
            Durable outputs you can preview, edit, or download
          </p>
        </div>
        <IconButton
          size="small"
          icon={refreshing ? SpinningRefreshIcon : RiRefreshLine}
          onClick={() => void load()}
          disabled={refreshing}
          aria-label="Refresh session files"
          title="Refresh"
          className="shrink-0"
        />
      </div>

      {available === false && artifacts.length === 0 ? (
        <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border-button-default bg-background-secondary-default px-5 text-center">
          <RiFileList2Line className="size-5 text-text-tertiary" aria-hidden />
          <p className="mt-3 text-body-2-medium text-text-primary">Files unavailable</p>
          <p className="mt-1 text-caption-1-regular text-text-secondary">Refresh to reconnect.</p>
        </div>
      ) : artifacts.length === 0 ? (
        <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border-button-default bg-background-secondary-default px-5 text-center">
          <RiFileList2Line className="size-5 text-text-tertiary" aria-hidden />
          <p className="mt-3 text-body-2-medium text-text-primary">
            {available === null ? "Loading files..." : "No files yet"}
          </p>
          <p className="mt-1 text-caption-1-regular text-text-secondary">
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
