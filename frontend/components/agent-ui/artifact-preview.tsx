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
      className={`overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-card ${className ?? ""}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border-button-default bg-background-secondary-default px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-background-primary-default text-text-secondary shadow-card">
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-body-2-medium text-text-primary">{artifact.name}</h3>
            <p className="truncate font-mono text-caption-1-regular text-text-tertiary">
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
              className="flex size-8 items-center justify-center rounded-lg text-text-tertiary outline-none hover:bg-background-secondary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiExternalLinkLine className="size-4" aria-hidden />
            </a>
          )}
          {view.actions.includes("download") && (
            <a
              href={artifact.download_url}
              download={artifact.name}
              aria-label={`Download ${artifact.name}`}
              className="flex size-8 items-center justify-center rounded-lg text-text-tertiary outline-none hover:bg-background-secondary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiDownloadLine className="size-4" aria-hidden />
            </a>
          )}
        </div>
      </div>
      {view.preview.renderer === "image" ? (
        <div className="relative h-52 bg-background-secondary-default bg-halftone">
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
        <div className="flex min-h-40 flex-col items-center justify-center gap-2 bg-background-secondary-default p-4 text-center">
          <Icon className="size-8 text-text-tertiary" aria-hidden />
          <p className="text-body-2-regular text-text-secondary">
            Open the authenticated preview to inspect this artifact.
          </p>
        </div>
      )}
    </article>
  );
}
