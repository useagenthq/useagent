"use client";

import { RiDownloadLine, RiFileLine } from "@remixicon/react";
import { useState } from "react";
import { formatArtifactSize } from "@/components/artifacts/model";
import type { RunUpload } from "@/components/chat/types";
import { ExpandedImageDialog } from "@/components/session-ui/expanded-image-dialog";

/** Authenticated bytes for an inbound upload (same-origin; the backend
 *  org-scopes a claimed upload exactly like an artifact). */
function contentUrl(id: string): string {
  return `/api/uploads/${id}/content`;
}

/** One image attachment: a bounded, lazily-loaded thumbnail that expands into
 *  the shared lightbox on click. Dimensions are capped so a large image never
 *  blows out the turn or eagerly decodes at full size. */
function ImageAttachment({ upload }: { upload: RunUpload }) {
  const [expanded, setExpanded] = useState(false);
  const src = contentUrl(upload.id);
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={`Expand ${upload.name}`}
        className="block cursor-zoom-in overflow-hidden rounded-xl border border-stroke-soft-200 bg-bg-weak-50 outline-none focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
      >
        {/* biome-ignore lint/performance/noImgElement: dynamic upload bytes
            (/api/uploads/:id/content), bounded + lazy - next/image optimization
            does not apply to authenticated same-origin blobs. */}
        <img
          src={src}
          alt={upload.name}
          loading="lazy"
          decoding="async"
          className="max-h-64 max-w-full object-contain"
        />
      </button>
      {expanded && (
        <ExpandedImageDialog
          preview={{ images: [{ src, name: upload.name }], index: 0 }}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}

/** A non-image attachment: a compact file card (name + size + download),
 *  matching the artifact card's AlignUI styling. */
function FileAttachment({ upload }: { upload: RunUpload }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 px-3 py-2.5">
      <RiFileLine aria-hidden className="size-5 shrink-0 text-text-sub-600" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-label-sm text-text-strong-950">{upload.name}</p>
        <p className="text-paragraph-xs text-text-soft-400">
          Attachment · {formatArtifactSize(upload.size_bytes)}
        </p>
      </div>
      <a
        href={contentUrl(upload.id)}
        download={upload.name}
        aria-label={`Download ${upload.name}`}
        title={`Download ${upload.name}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-text-sub-600 outline-none hover:bg-bg-white-0 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
      >
        <RiDownloadLine aria-hidden className="size-4" />
      </a>
    </div>
  );
}

/**
 * The user turn's inbound attachments: what the person sent with the message
 * (a Slack file or a browser upload), so a human reading the thread sees the
 * image/file that was attached - not only what the agent published back.
 * Images render inline (bounded, lazy, click-to-expand); everything else is a
 * small file card. Renders nothing when there are no attachments.
 */
export function InboundAttachments({ uploads }: { uploads?: readonly RunUpload[] }) {
  if (!uploads || uploads.length === 0) return null;
  return (
    <div className="flex flex-col items-end gap-2" data-testid="inbound-attachments">
      {uploads.map((upload) =>
        upload.content_type.startsWith("image/") ? (
          <ImageAttachment key={upload.id} upload={upload} />
        ) : (
          <FileAttachment key={upload.id} upload={upload} />
        ),
      )}
    </div>
  );
}
