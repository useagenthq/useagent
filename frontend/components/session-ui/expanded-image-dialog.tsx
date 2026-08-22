"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/chat/ExpandedImageDialog.tsx (the lightbox:
// scrim + centered full-size image + name/counter caption + prev/next arrows +
// arrow-key navigation) and ExpandedImagePreview.tsx (the ExpandedImageItem /
// ExpandedImagePreview shapes).
//
// Port notes:
// - Their hand-rolled fixed overlay, Escape handler, backdrop close button and
//   shadcn X button -> our AlignUI Modal primitive (Radix dialog): Escape and
//   outside-click close via onOpenChange, the X is the modal's stock close,
//   the scrim is the bg-overlay token instead of bg-black/75.
// - lucide chevrons -> @remixicon/react; shadcn ghost Buttons -> plain tokened
//   buttons. Arrows anchor to the image container (the modal owns the viewport).
// - buildExpandedImagePreview (multi-image collection helper) is not ported:
//   our timeline opens one artifact per row, so the caller builds a one-image
//   preview at the leaf. Multi-image navigation stays intact for reuse.

import { RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react";
import { memo, useCallback, useEffect, useState } from "react";
import * as Modal from "@/components/ui/modal";

export interface ExpandedImageItem {
  src: string;
  name: string;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

/** Caption under the expanded image: its name, plus position when browsing a set. */
export function expandedImageCaption(name: string, index: number, count: number): string {
  return count > 1 ? `${name} (${index + 1}/${count})` : name;
}

/**
 * Full-size lightbox for an image already rendered in the timeline. Purely
 * presentational leaf: the caller owns the open state and passes `onClose`.
 */
export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: {
  preview: ExpandedImagePreview;
  onClose: () => void;
}) {
  const [imageOffset, setImageOffset] = useState(0);
  const index = (preview.index + imageOffset + preview.images.length) % preview.images.length;

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  }, []);

  // Arrow-key navigation between images; Escape is the modal's own close path.
  useEffect(() => {
    if (preview.images.length <= 1) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateImage(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateImage, preview.images.length]);

  const item = preview.images[index];
  if (!item) return null;

  return (
    <Modal.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Content
        data-session-ui="expanded-image-dialog"
        aria-describedby={undefined}
        className="w-auto max-w-[92vw] border-none bg-transparent shadow-none"
      >
        <Modal.Title className="sr-only">Expanded image preview</Modal.Title>
        <div className="relative">
          {preview.images.length > 1 && (
            <button
              type="button"
              aria-label="Previous image"
              onClick={() => navigateImage(-1)}
              className="absolute left-2 top-1/2 z-20 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg bg-foreground-icon-primary/60 text-background-full outline-none transition-colors hover:bg-foreground-icon-primary/80 focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiArrowLeftSLine aria-hidden className="size-5" />
            </button>
          )}
          {/* biome-ignore lint/performance/noImgElement: dynamic artifact bytes
              (/api/artifacts/:id/content) shown full-size in a lightbox -
              next/image optimization does not apply. */}
          <img
            src={item.src}
            alt={item.name}
            className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border-button-default bg-background-primary-default object-contain shadow-md"
            draggable={false}
          />
          {preview.images.length > 1 && (
            <button
              type="button"
              aria-label="Next image"
              onClick={() => navigateImage(1)}
              className="absolute right-2 top-1/2 z-20 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg bg-foreground-icon-primary/60 text-background-full outline-none transition-colors hover:bg-foreground-icon-primary/80 focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiArrowRightSLine aria-hidden className="size-5" />
            </button>
          )}
        </div>
        <p className="mt-2 max-w-[92vw] truncate text-center text-caption-1-regular text-text-tertiary">
          {expandedImageCaption(item.name, index, preview.images.length)}
        </p>
      </Modal.Content>
    </Modal.Root>
  );
});
