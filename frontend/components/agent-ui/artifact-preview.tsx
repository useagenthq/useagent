import {
  type RemixiconComponentType,
  RiDownloadLine,
  RiExternalLinkLine,
  RiFileCodeLine,
  RiFileTextLine,
  RiImageLine,
} from "@remixicon/react";
import Image from "next/image";
import { CodeBlock } from "@/components/ai/code-block";
import {
  type ArtifactCategory,
  type ArtifactDescriptor,
  artifactViewFor,
  formatArtifactSize,
} from "@/components/artifacts/model";

const CATEGORY_ICON: Record<ArtifactCategory, RemixiconComponentType> = {
  files: RiFileCodeLine,
  docs: RiFileTextLine,
  media: RiImageLine,
};

export interface ArtifactPreviewProps {
  readonly artifact: ArtifactDescriptor;
  readonly textPreview?: {
    readonly content: string;
    readonly language?: string;
  };
  readonly className?: string;
}

export function ArtifactPreview({ artifact, textPreview, className }: ArtifactPreviewProps) {
  const view = artifactViewFor(artifact);
  const Icon = CATEGORY_ICON[view.category];

  return (
    <article
      aria-label={`Artifact preview: ${artifact.name}`}
      className={`overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs ${className ?? ""}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-stroke-soft-200 bg-bg-weak-50 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-bg-white-0 text-text-sub-600 shadow-regular-xs">
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-label-sm text-text-strong-950">{artifact.name}</h3>
            <p className="truncate font-mono text-paragraph-xs text-text-soft-400">
              {artifact.source_path} · {formatArtifactSize(artifact.size_bytes)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {view.actions.includes("preview") && (
            <a
              href={artifact.preview_url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open preview of ${artifact.name}`}
              className="flex size-8 items-center justify-center rounded-lg text-text-soft-400 outline-none hover:bg-bg-soft-200 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base"
            >
              <RiExternalLinkLine className="size-4" aria-hidden />
            </a>
          )}
          {view.actions.includes("download") && (
            <a
              href={artifact.download_url}
              download={artifact.name}
              aria-label={`Download ${artifact.name}`}
              className="flex size-8 items-center justify-center rounded-lg text-text-soft-400 outline-none hover:bg-bg-soft-200 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base"
            >
              <RiDownloadLine className="size-4" aria-hidden />
            </a>
          )}
        </div>
      </div>
      {view.preview.renderer === "image" ? (
        <div className="relative h-52 bg-bg-weak-50 bg-halftone">
          <Image
            src={artifact.preview_url}
            alt={`Preview of ${artifact.name}`}
            fill
            unoptimized
            sizes="(max-width: 1024px) 100vw, 50vw"
            className="object-contain p-4"
          />
        </div>
      ) : textPreview ? (
        <CodeBlock
          code={textPreview.content}
          language={textPreview.language}
          filename={artifact.name}
          className="rounded-none border-0 shadow-none"
        />
      ) : (
        <div className="flex min-h-40 flex-col items-center justify-center gap-2 bg-bg-weak-50 p-4 text-center">
          <Icon className="size-8 text-text-soft-400" aria-hidden />
          <p className="text-paragraph-sm text-text-sub-600">
            Open the authenticated preview to inspect this artifact.
          </p>
        </div>
      )}
    </article>
  );
}
