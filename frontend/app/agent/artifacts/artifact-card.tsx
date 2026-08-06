import {
  RiFileTextLine,
  RiFolder3Line,
  RiImageLine,
  RiPulseLine,
  RiTerminalBoxLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import Link from "next/link";
import { StatusDot } from "@/components/shared/status-dot";
import type { Artifact, ArtifactCategory } from "./derive";

const CATEGORY_ICON: Record<ArtifactCategory, RemixiconComponentType> = {
  code: RiTerminalBoxLine,
  docs: RiFileTextLine,
  media: RiImageLine,
};

function truncate(value: string, max = 42): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** Amber, gently pulsing "LIVE" chip for the newest file of a running run. */
function LiveChip() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke-soft-200 bg-bg-white-0 px-2 py-1 shadow-regular-xs">
      <StatusDot tone="away" pulse />
      <span className="text-mono-label text-text-sub-600">Live</span>
    </span>
  );
}

/** Floating folder chip — the run's workspace lane. */
function FolderChip({ label }: { label: string }) {
  return (
    <span className="inline-flex max-w-[9rem] items-center gap-1.5 rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-2.5 py-1.5 shadow-regular-xs">
      <RiFolder3Line aria-hidden className="size-3.5 shrink-0 text-text-soft-400" />
      <span className="truncate text-label-xs text-text-sub-600">{label}</span>
    </span>
  );
}

/**
 * A single artifact: a preview scene (folder chip + centered file-type tile on
 * the secondary canvas) over the filename, a mono "size · date" caption, and a
 * link back to the run that produced it.
 */
export function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const Icon = CATEGORY_ICON[artifact.category];
  const type = artifact.ext.replace(".", "").toUpperCase();

  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs transition-colors hover:border-stroke-sub-300">
      {/* Preview scene */}
      <div className="relative h-44 overflow-hidden bg-bg-weak-50 bg-halftone">
        <div className="absolute left-4 top-4">
          <FolderChip label={artifact.lane} />
        </div>
        {artifact.live && (
          <div className="absolute right-4 top-4">
            <LiveChip />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-4 flex justify-center">
          <div className="flex w-32 flex-col items-center gap-2 rounded-xl border border-stroke-soft-200 bg-bg-white-0 px-4 py-4 shadow-regular-xs">
            <Icon aria-hidden className="size-7 text-text-sub-600" />
            <span className="text-mono-label text-text-soft-400">{type}</span>
          </div>
        </div>
      </div>

      {/* Meta */}
      <div className="flex flex-col gap-1 px-4 py-3.5">
        <p className="truncate text-label-sm text-text-strong-950" title={artifact.name}>
          {artifact.name}
        </p>
        <p className="font-mono text-paragraph-xs text-text-soft-400">
          {artifact.size} · {artifact.date}
        </p>
        <Link
          href={`/session/${artifact.runId}`}
          className="mt-0.5 inline-flex items-center gap-1.5 text-paragraph-xs text-text-sub-600 transition-colors hover:text-text-strong-950"
        >
          <RiPulseLine aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{truncate(artifact.runPrompt)}</span>
        </Link>
      </div>
    </article>
  );
}
