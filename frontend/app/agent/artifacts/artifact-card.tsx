import {
  RiDownloadLine,
  RiEditLine,
  RiExternalLinkLine,
  RiFileCodeLine,
  RiFileTextLine,
  RiImageLine,
  RiPulseLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import Image from "next/image";
import Link from "next/link";
import {
  artifactViewFor,
  formatArtifactDate,
  formatArtifactSize,
  type ArtifactCategory,
  type ArtifactDescriptor,
} from "@/components/artifacts/model";

const CATEGORY_ICON: Record<ArtifactCategory, RemixiconComponentType> = {
  files: RiFileCodeLine,
  docs: RiFileTextLine,
  media: RiImageLine,
};

/** Shared icon-button chrome for the edit/preview/download actions. */
const ACTION_BTN =
  "flex size-8 items-center justify-center rounded-lg border border-border-button-default bg-background-primary-default text-text-secondary shadow-card outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring";

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function ArtifactPreview({
  artifact,
  view,
}: {
  artifact: ArtifactDescriptor;
  view: ReturnType<typeof artifactViewFor>;
}) {
  const Icon = CATEGORY_ICON[view.category];
  if (view.preview.renderer === "image") {
    return (
      <Image
        src={artifact.preview_url}
        alt={`Preview of ${artifact.name}`}
        fill
        unoptimized
        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
        className="object-contain p-4"
      />
    );
  }
  if (view.preview.renderer === "video") {
    // preload="metadata" pulls only the first frame - a real thumbnail without
    // fetching the whole file.
    return (
      <video
        src={artifact.preview_url}
        muted
        playsInline
        preload="metadata"
        aria-label={`Preview of ${artifact.name}`}
        className="absolute inset-0 size-full object-contain"
      />
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5">
      <Icon aria-hidden className="size-9 text-text-secondary" />
      <span className="font-mono text-caption-1-medium text-text-tertiary">
        {view.extension}
      </span>
    </div>
  );
}

/** The edit / preview / download action links, shared by the tile and the row. */
function ArtifactActions({
  artifact,
  view,
}: {
  artifact: ArtifactDescriptor;
  view: ReturnType<typeof artifactViewFor>;
}) {
  return (
    <>
      {view.actions.includes("edit") && (
        <Link
          href={`/agent/artifacts/${artifact.id}`}
          aria-label={`Edit ${artifact.name}`}
          title="Edit"
          className={ACTION_BTN}
        >
          <RiEditLine aria-hidden className="size-4" />
        </Link>
      )}
      {view.actions.includes("preview") && (
        <a
          href={artifact.preview_url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Preview ${artifact.name}`}
          title="Preview"
          className={ACTION_BTN}
        >
          <RiExternalLinkLine aria-hidden className="size-4" />
        </a>
      )}
      {view.actions.includes("download") && (
        <a
          href={artifact.download_url}
          download={artifact.name}
          aria-label={`Download ${artifact.name}`}
          title="Download"
          className={ACTION_BTN}
        >
          <RiDownloadLine aria-hidden className="size-4" />
        </a>
      )}
    </>
  );
}

/** A media artifact (image / video) as a thumbnail tile. Preview and download use
 * the authenticated backend byte endpoint; no filename, size, or content is
 * synthesized. */
export function ArtifactCard({ artifact }: { artifact: ArtifactDescriptor }) {
  const view = artifactViewFor(artifact);
  return (
    <article className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-button-default bg-background-primary-default shadow-card transition-colors hover:border-border-button-hover">
      <div className="relative h-44 overflow-hidden bg-background-secondary-default bg-halftone">
        <ArtifactPreview artifact={artifact} view={view} />
        <div className="absolute right-3 top-3 flex items-center gap-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <ArtifactActions artifact={artifact} view={view} />
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-1 px-4 py-3.5">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <p className="truncate text-body-2-medium text-text-primary" title={artifact.name}>
            {artifact.name}
          </p>
          <span className="shrink-0 font-mono text-caption-1-regular text-text-tertiary">
            {formatArtifactSize(artifact.size_bytes)}
          </span>
        </div>
        <p className="truncate font-mono text-caption-1-regular text-text-tertiary" title={artifact.source_path}>
          {artifact.source_path}
        </p>
        <div className="mt-1 flex min-w-0 items-center justify-between gap-3">
          <Link
            href={`/session/${artifact.thread_id}`}
            className="inline-flex min-w-0 items-center gap-1.5 text-caption-1-regular text-text-secondary outline-none transition-colors hover:text-text-primary focus-visible:underline"
          >
            <RiPulseLine aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">Run {shortId(artifact.run_id)}</span>
          </Link>
          <time
            dateTime={artifact.created_at}
            className="shrink-0 text-caption-1-regular text-text-tertiary"
          >
            {formatArtifactDate(artifact.created_at)}
          </time>
        </div>
      </div>
    </article>
  );
}

/** A non-media artifact (doc / code / pdf / text) as a compact list row - name +
 * mono path + size + run + time, actions revealed on hover. Tiny text files no
 * longer get a huge empty preview tile. */
export function ArtifactRow({ artifact }: { artifact: ArtifactDescriptor }) {
  const view = artifactViewFor(artifact);
  const Icon = CATEGORY_ICON[view.category];
  return (
    <li className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-background-secondary-default">
      <Icon aria-hidden className="size-4 shrink-0 text-text-secondary" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-body-2-medium text-text-primary" title={artifact.name}>
          {artifact.name}
        </span>
        <span
          className="hidden min-w-0 shrink truncate font-mono text-caption-1-regular text-text-tertiary sm:block"
          title={artifact.source_path}
        >
          {artifact.source_path}
        </span>
      </div>
      <span className="shrink-0 font-mono text-caption-1-regular tabular-nums text-text-tertiary">
        {formatArtifactSize(artifact.size_bytes)}
      </span>
      <Link
        href={`/session/${artifact.thread_id}`}
        className="hidden shrink-0 items-center gap-1.5 text-caption-1-regular text-text-secondary outline-none transition-colors hover:text-text-primary focus-visible:underline md:inline-flex"
      >
        <RiPulseLine aria-hidden className="size-3.5 shrink-0" />
        <span>Run {shortId(artifact.run_id)}</span>
      </Link>
      <time
        dateTime={artifact.created_at}
        className="hidden shrink-0 text-caption-1-regular text-text-tertiary lg:block"
      >
        {formatArtifactDate(artifact.created_at)}
      </time>
      <div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <ArtifactActions artifact={artifact} view={view} />
      </div>
    </li>
  );
}
