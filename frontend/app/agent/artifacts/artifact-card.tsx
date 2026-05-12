import {
  RiDownloadLine,
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
  categoryForArtifact,
  extensionLabel,
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

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function isRasterImage(contentType: string): boolean {
  return ["image/gif", "image/jpeg", "image/png", "image/webp"].includes(
    contentType.split(";", 1)[0]?.toLowerCase() ?? "",
  );
}

function ArtifactPreview({ artifact }: { artifact: ArtifactDescriptor }) {
  const category = categoryForArtifact(artifact);
  const Icon = CATEGORY_ICON[category];
  if (isRasterImage(artifact.content_type)) {
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
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5">
      <Icon aria-hidden className="size-9 text-text-sub-600" />
      <span className="font-mono text-label-xs text-text-soft-400">
        {extensionLabel(artifact.name)}
      </span>
    </div>
  );
}

/** One durable artifact record. Preview and download use the authenticated
 * backend byte endpoint; no filename, size, status, or content is synthesized. */
export function ArtifactCard({ artifact }: { artifact: ArtifactDescriptor }) {
  return (
    <article className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs transition-colors hover:border-stroke-sub-300">
      <div className="relative h-44 overflow-hidden bg-bg-weak-50 bg-halftone">
        <ArtifactPreview artifact={artifact} />
        <div className="absolute right-3 top-3 flex items-center gap-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <a
            href={artifact.preview_url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Preview ${artifact.name}`}
            title="Preview"
            className="flex size-8 items-center justify-center rounded-lg border border-stroke-soft-200 bg-bg-white-0 text-text-sub-600 shadow-regular-xs outline-none hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
          >
            <RiExternalLinkLine aria-hidden className="size-4" />
          </a>
          <a
            href={artifact.download_url}
            download={artifact.name}
            aria-label={`Download ${artifact.name}`}
            title="Download"
            className="flex size-8 items-center justify-center rounded-lg border border-stroke-soft-200 bg-bg-white-0 text-text-sub-600 shadow-regular-xs outline-none hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
          >
            <RiDownloadLine aria-hidden className="size-4" />
          </a>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-1 px-4 py-3.5">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <p className="truncate text-label-sm text-text-strong-950" title={artifact.name}>
            {artifact.name}
          </p>
          <span className="shrink-0 font-mono text-paragraph-xs text-text-soft-400">
            {formatArtifactSize(artifact.size_bytes)}
          </span>
        </div>
        <p className="truncate font-mono text-paragraph-xs text-text-soft-400" title={artifact.source_path}>
          {artifact.source_path}
        </p>
        <div className="mt-1 flex min-w-0 items-center justify-between gap-3">
          <Link
            href={`/session/${artifact.thread_id}`}
            className="inline-flex min-w-0 items-center gap-1.5 text-paragraph-xs text-text-sub-600 outline-none transition-colors hover:text-text-strong-950 focus-visible:underline"
          >
            <RiPulseLine aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">Run {shortId(artifact.run_id)}</span>
          </Link>
          <time
            dateTime={artifact.created_at}
            className="shrink-0 text-paragraph-xs text-text-soft-400"
          >
            {formatArtifactDate(artifact.created_at)}
          </time>
        </div>
      </div>
    </article>
  );
}
