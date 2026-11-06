"use client";

// The composer's attachment row: our upload records drawn with the BoardUI Pro
// Composer Panel tiles (composer-panel/composer-panel.tsx). A tile in flight
// carries its upload's progress ring, a landed one its remove mark, a failed
// one the warning mark. Under the tiles, one line says why a file failed or was
// left out, and what to do when it is what holds Send back.

import type { RunUpload, UploadNotice } from "@/components/chat/run-uploads";
import {
  type ComposerAttachment,
  ComposerAttachmentStrip,
} from "@/components/pro/composer-panel/composer-panel";
import { cx } from "@/utils/cx";

/** The tile for an upload record. */
export function composerAttachment(upload: RunUpload): ComposerAttachment {
  return {
    id: upload.localId,
    name: upload.name,
    kind: upload.kind,
    ...(upload.previewUrl ? { src: upload.previewUrl } : {}),
    ...(upload.status === "uploading" ? { progress: upload.progress } : {}),
    ...(upload.status === "error" ? { failed: true } : {}),
    ...(upload.status === "error" && upload.error ? { failedReason: upload.error } : {}),
  };
}

export function ComposerAttachmentRow({
  uploads,
  onRemove,
  className,
}: {
  uploads: readonly RunUpload[];
  onRemove: (upload: RunUpload) => void;
  className?: string;
}) {
  if (uploads.length === 0) return null;
  return (
    <ComposerAttachmentStrip
      attachments={uploads.map(composerAttachment)}
      onRemove={(id) => {
        const upload = uploads.find((item) => item.localId === id);
        if (upload) onRemove(upload);
      }}
      className={className}
    />
  );
}

/**
 * The line under the tiles: why a file failed (and that removing it frees
 * Send), or how many files the 10-file cap left out. It stays mounted as a
 * polite live region so a screen reader hears the line when it appears.
 */
export function ComposerUploadNotice({
  notice,
  className,
}: {
  notice: UploadNotice | null;
  className?: string;
}) {
  return (
    <p
      role="status"
      data-tone={notice?.tone}
      className={cx(
        // A long file name with no spaces wraps instead of widening the composer.
        "break-words text-caption-1-regular",
        notice?.tone === "error" ? "text-text-error-primary" : "text-text-secondary",
        notice ? className : "sr-only",
      )}
    >
      {notice?.text}
    </p>
  );
}
