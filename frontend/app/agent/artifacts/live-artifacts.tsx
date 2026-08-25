"use client";

import {
  RiAddLine,
  RiBroadcastLine,
  RiDownloadLine,
  RiRefreshLine,
  RiUpload2Line,
} from "@remixicon/react";
import {
  ARTIFACT_AUTHORING_PROFILES,
  type ArtifactWorkpieceKind,
} from "@useagent/artifact-workspace";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  artifactViewFor,
  extractArtifactResult,
  extractArtifacts,
  type ArtifactCategory,
  type ArtifactDescriptor,
} from "@/components/artifacts/model";
import {
  Dropdown,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/base/segmented-control/segmented-control";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";
import { ArtifactCard, ArtifactRow } from "./artifact-card";

type Filter = "all" | ArtifactCategory;

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "files", label: "Files" },
  { id: "docs", label: "Docs" },
  { id: "media", label: "Media" },
];

const REFRESH_MS = 5_000;

function uniqueRuns(artifacts: readonly ArtifactDescriptor[], initialRunId?: string) {
  const byRun = new Map<string, { runId: string; label: string }>();
  if (initialRunId) byRun.set(initialRunId, { runId: initialRunId, label: shortRun(initialRunId) });
  for (const artifact of artifacts) {
    if (!byRun.has(artifact.run_id)) {
      byRun.set(artifact.run_id, { runId: artifact.run_id, label: shortRun(artifact.run_id) });
    }
  }
  return [...byRun.values()];
}

function shortRun(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function ArtifactCreatePanel({
  artifacts,
  initialRunId,
  onCreated,
}: {
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly initialRunId?: string;
  readonly onCreated: (artifact: ArtifactDescriptor) => void;
}) {
  const runs = useMemo(() => uniqueRuns(artifacts, initialRunId), [artifacts, initialRunId]);
  const [kind, setKind] = useState<ArtifactWorkpieceKind>("document");
  const [name, setName] = useState<string>(ARTIFACT_AUTHORING_PROFILES[0]?.defaultName ?? "");
  const [runId, setRunId] = useState(initialRunId ?? runs[0]?.runId ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId && runs[0]) setRunId(runs[0].runId);
  }, [runId, runs]);

  const chooseKind = (next: ArtifactWorkpieceKind) => {
    setKind(next);
    setName(ARTIFACT_AUTHORING_PROFILES.find((profile) => profile.kind === next)?.defaultName ?? "");
  };

  const create = async () => {
    if (!runId) return;
    setSubmitting(true);
    setError(null);
    try {
      let uploadId: string | undefined;
      if (file) {
        const form = new FormData();
        form.set("file", file);
        const uploadResponse = await backendFetch("/api/uploads", { method: "POST", body: form });
        if (!uploadResponse.ok) throw new Error(`upload failed (${uploadResponse.status})`);
        const uploadBody = (await uploadResponse.json()) as { upload?: { id?: unknown } };
        if (typeof uploadBody.upload?.id !== "string") throw new Error("upload id missing");
        uploadId = uploadBody.upload.id;
      }
      const response = await backendFetch("/api/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: runId,
          kind,
          name,
          ...(uploadId ? { upload_id: uploadId } : {}),
        }),
      });
      const artifact = extractArtifactResult(await response.json());
      if (!response.ok || !artifact) throw new Error(`create failed (${response.status})`);
      onCreated(artifact);
      setFile(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The artifact could not be created.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-3">
      <label className="flex flex-col gap-1 text-caption-1-medium text-text-secondary">
        Type
        <select
          value={kind}
          onChange={(event) => chooseKind(event.currentTarget.value as ArtifactWorkpieceKind)}
          className="h-9 w-full rounded-lg border border-border-button-default bg-background-primary-default px-3 text-body-2-medium text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          {ARTIFACT_AUTHORING_PROFILES.map((profile) => (
            <option key={profile.kind} value={profile.kind}>
              {profile.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-caption-1-medium text-text-secondary">
        Name
        <input
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          className="h-9 w-full rounded-lg border border-border-button-default bg-background-primary-default px-3 text-body-2-medium text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        />
      </label>
      <label className="flex flex-col gap-1 text-caption-1-medium text-text-secondary">
        Run
        <select
          value={runId}
          onChange={(event) => setRunId(event.currentTarget.value)}
          disabled={runs.length === 0}
          className="h-9 w-full rounded-lg border border-border-button-default bg-background-primary-default px-3 text-body-2-medium text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:opacity-50"
        >
          {runs.map((artifact) => (
            <option key={artifact.runId} value={artifact.runId}>
              {artifact.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center justify-between gap-2">
        <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border-button-default bg-background-primary-default px-3 text-body-2-medium text-text-secondary outline-none hover:bg-background-secondary-default hover:text-text-primary">
          <RiUpload2Line aria-hidden className="size-4" />
          {file ? "Replace upload" : "Upload"}
          <input
            type="file"
            className="sr-only"
            onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
          />
        </label>
        <button
          type="button"
          onClick={() => void create()}
          disabled={!runId || submitting}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-foreground-icon-primary px-4 text-body-2-medium text-background-full outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RiAddLine aria-hidden className="size-4" />
          {submitting ? "Creating..." : "Create"}
        </button>
      </div>
      {file && (
        <p className="truncate text-caption-1-regular text-text-tertiary">
          Immutable original: {file.name}
        </p>
      )}
      {runs.length === 0 && (
        <p className="text-caption-1-regular text-text-tertiary">
          Create is available after at least one run exists, or from a link with a run_id parameter.
        </p>
      )}
      {error && <p className="text-caption-1-regular text-text-error-primary">{error}</p>}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-10 flex flex-col items-center justify-center rounded-xl border border-dashed border-border-button-default bg-background-secondary-default px-6 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-full border border-border-button-default bg-background-primary-default">
        <RiBroadcastLine aria-hidden className="size-5 text-text-tertiary" />
      </div>
      <h2 className="mt-4 text-title-2-medium text-text-primary">No artifacts yet</h2>
      <p className="mt-1 max-w-sm text-body-2-regular text-text-secondary">
        Screenshots, reports, documents, and other files published by your agents will appear here.
      </p>
      <Link
        href="/agent/new"
        className="mt-5 inline-flex h-9 items-center rounded-full bg-foreground-icon-primary px-4 text-body-2-medium text-background-full shadow-card outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2"
      >
        Start a run
      </Link>
    </div>
  );
}

function UnavailableState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mt-10 flex flex-col items-center justify-center rounded-xl border border-dashed border-border-button-default bg-background-secondary-default px-6 py-16 text-center">
      <RiBroadcastLine aria-hidden className="size-6 text-text-tertiary" />
      <h2 className="mt-4 text-title-2-medium text-text-primary">Artifacts are unavailable</h2>
      <p className="mt-1 max-w-sm text-body-2-regular text-text-secondary">
        The artifact service could not be reached. Your existing files are not deleted.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 inline-flex h-9 items-center rounded-full bg-foreground-icon-primary px-4 text-body-2-medium text-background-full shadow-card outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2"
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
  initialRunId,
}: {
  initialArtifacts: ArtifactDescriptor[];
  initialAvailable: boolean;
  initialRunId?: string;
}) {
  const [artifacts, setArtifacts] = useState(initialArtifacts);
  const [available, setAvailable] = useState(initialAvailable);
  const [filter, setFilter] = useState<Filter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

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
        : artifacts.filter((artifact) => artifactViewFor(artifact).category === filter),
    [artifacts, filter],
  );

  // "Download all" bundles a single run's artifacts. Only offer it when the
  // visible set resolves to exactly one run, so the ZIP has an unambiguous scope.
  const soleRunId = useMemo(() => {
    const runs = new Set(visible.map((artifact) => artifact.run_id));
    return runs.size === 1 ? [...runs][0] : null;
  }, [visible]);

  // Tiles only for artifacts with a real thumbnail (image / video); everything
  // else (docs, code, pdf, text) renders as a compact row instead of a hollow tile.
  const { tiles, rows } = useMemo(() => {
    const tiles: ArtifactDescriptor[] = [];
    const rows: ArtifactDescriptor[] = [];
    for (const artifact of visible) {
      const renderer = artifactViewFor(artifact).preview.renderer;
      if (renderer === "image" || renderer === "video") tiles.push(artifact);
      else rows.push(artifact);
    }
    return { tiles, rows };
  }, [visible]);

  return (
    <div className="mx-auto w-full max-w-[1120px] px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-2.5">
          <RiBroadcastLine aria-hidden className="mt-0.5 size-5 text-text-primary" />
          <div className="flex flex-col gap-0.5">
            <h1 className="text-display-sm text-text-primary">Artifacts</h1>
            <p className="text-body-2-regular text-text-secondary">
              Durable files published by agent runs
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Dropdown isOpen={createOpen} onOpenChange={setCreateOpen}>
            <DropdownTrigger className="inline-flex h-9 items-center gap-2 rounded-lg bg-foreground-icon-primary px-3 text-body-2-medium text-background-full transition-opacity hover:opacity-90">
              <RiAddLine aria-hidden className="size-4" />
              New
            </DropdownTrigger>
            <DropdownPopover
              aria-label="New artifact"
              placement="bottom end"
              className="w-[360px] p-4"
              dialogClassName="gap-3"
            >
              <ArtifactCreatePanel
                artifacts={artifacts}
                initialRunId={initialRunId}
                onCreated={(artifact) => {
                  setArtifacts((current) => [
                    artifact,
                    ...current.filter((item) => item.id !== artifact.id),
                  ]);
                  setAvailable(true);
                  setCreateOpen(false);
                }}
              />
            </DropdownPopover>
          </Dropdown>
          {soleRunId && (
            <a
              href={`/api/artifacts/runs/${soleRunId}/archive`}
              download
              aria-label="Download all artifacts as a ZIP"
              title="Download all"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-button-default bg-background-primary-default px-3 text-body-2-medium text-text-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiDownloadLine aria-hidden className="size-4" />
              Download all
            </a>
          )}
          <button
            type="button"
            onClick={() => void load()}
            aria-label="Refresh artifacts"
            title="Refresh"
            disabled={refreshing}
            className="flex size-9 items-center justify-center rounded-lg border border-border-button-default bg-background-primary-default text-text-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:opacity-50"
          >
            <RiRefreshLine
              aria-hidden
              className={`size-4 ${refreshing ? "animate-spin" : ""}`}
            />
          </button>
          <SegmentedControl
            aria-label="Filter artifacts"
            className="w-auto"
            selectedKeys={[filter]}
            onSelectionChange={(keys) => {
              const next = [...(keys as Set<string>)][0];
              if (next) setFilter(next as Filter);
            }}
          >
            {FILTERS.map(({ id, label }) => (
              <SegmentedControlItem key={id} id={id} className="px-3">
                {label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
      </div>

      {!available && artifacts.length > 0 && (
        <p role="status" className="mt-4 text-caption-1-regular text-text-tertiary">
          Reconnecting to the artifact service. Showing the last loaded files.
        </p>
      )}

      {!available && artifacts.length === 0 ? (
        <UnavailableState onRetry={() => void load()} />
      ) : artifacts.length === 0 ? (
        <EmptyState />
      ) : visible.length > 0 ? (
        <>
          {tiles.length > 0 && (
            <div className="mt-8 grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
              {tiles.map((artifact) => (
                <ArtifactCard key={artifact.id} artifact={artifact} />
              ))}
            </div>
          )}
          {rows.length > 0 && (
            <ul className="mt-6 divide-y divide-separator-border overflow-hidden rounded-2xl bg-background-primary-default shadow-sm ring-1 ring-inset ring-border-button-default">
              {rows.map((artifact) => (
                <ArtifactRow key={artifact.id} artifact={artifact} />
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="mt-10 text-body-2-regular text-text-secondary">
          No {FILTERS.find((item) => item.id === filter)?.label.toLowerCase()} artifacts yet.
        </p>
      )}
    </div>
  );
}
