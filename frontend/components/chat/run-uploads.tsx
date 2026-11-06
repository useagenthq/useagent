"use client";

import type { ClipboardEvent, DragEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { backendFetch, backendUpload } from "@/lib/backend-fetch";

/** What a composer tile shows for a file: the thumbnail for an image, one typed
 *  icon for the rest, the paperclip when the file is none of the known kinds. */
export type AttachmentKind =
  | "image"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "code"
  | "video"
  | "file";

export type RunUpload = {
  readonly localId: string;
  readonly id: string | null;
  readonly name: string;
  readonly sizeBytes: number;
  readonly status: "uploading" | "ready" | "error";
  readonly kind: AttachmentKind;
  /** Object URL of a picked image, the tile's thumbnail; released with the tile. */
  readonly previewUrl: string | null;
  /** Bytes sent so far, 0 to 100: the tile's ring while the upload is in flight. */
  readonly progress: number;
  /** Why a failed upload did not land, worded to follow its name
   *  ("report.pdf is over the 25 MB limit"); see `uploadFailureReason`. */
  readonly error?: string;
};

type UploadResponse = {
  upload?: { id?: unknown; name?: unknown; size_bytes?: unknown };
};

/** The most files one message carries. */
export const MAX_FILES = 10;
/** The backend's per-file cap (`MAX_UPLOAD_BYTES` in backend/src/uploads/routes.ts). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const DID_NOT_UPLOAD = "did not upload";

/**
 * Why an upload did not land, worded to follow the file's name. `status` is
 * the HTTP status, or null when the request never got a response; `serverError`
 * is the `error` field of the backend's reply (backend/src/uploads/routes.ts).
 */
export function uploadFailureReason(status: number | null, serverError?: unknown): string {
  if (status === null) return "did not upload because the server could not be reached";
  if (serverError === "file exceeds 25 MB limit" || status === 413)
    return "is over the 25 MB limit";
  if (serverError === "file is empty") return "is empty";
  if (serverError === "invalid file name") return "has a name that cannot be uploaded";
  if (serverError === "upload_scan_failed" || status === 422) return "did not pass the upload scan";
  if (status === 401) return "did not upload because you are signed out";
  return DID_NOT_UPLOAD;
}

/** The reason a file fails before it is sent, or null when it may go. */
export function preflightFailure(file: Pick<File, "size">): string | null {
  if (file.size <= 0) return uploadFailureReason(400, "file is empty");
  if (file.size > MAX_UPLOAD_BYTES) return uploadFailureReason(413);
  return null;
}

/** What the composer says about its files: an error blocks Send, info does not. */
export type UploadNotice = { readonly tone: "error" | "info"; readonly text: string };

/**
 * The line under the attachment tiles. A failed file blocks Send, so it comes
 * first and says what to do; files cut by the 10-file cap come next.
 */
export function uploadNotice(
  uploads: readonly Pick<RunUpload, "name" | "status" | "error">[],
  leftOut: number,
): UploadNotice | null {
  const failed = uploads.filter((upload) => upload.status === "error");
  if (failed.length === 1) {
    const [only] = failed;
    return {
      tone: "error",
      text: `Remove ${only.name} to send. It ${only.error ?? DID_NOT_UPLOAD}.`,
    };
  }
  if (failed.length > 1) {
    return {
      tone: "error",
      text: `Remove the ${failed.length} failed files to send. ${failed[0].name} ${failed[0].error ?? DID_NOT_UPLOAD}.`,
    };
  }
  if (leftOut > 0) {
    const files = leftOut === 1 ? "1 file was" : `${leftOut} files were`;
    return {
      tone: "info",
      text: `${files} left out. A message can carry up to ${MAX_FILES} files.`,
    };
  }
  return null;
}

const EXTENSIONS: Record<Exclude<AttachmentKind, "file">, string> = {
  image: "png jpg jpeg gif webp svg heic heif avif bmp tif tiff",
  video: "mp4 mov webm mkv m4v avi",
  spreadsheet: "csv tsv xls xlsx xlsm numbers ods",
  presentation: "ppt pptx key odp",
  document: "pdf doc docx md txt rtf pages odt",
  code: "ts tsx js jsx mjs cjs json yaml yml toml py rb go rs java kt swift c h cpp hpp cs php sh bash zsh css scss html htm sql xml",
};

const KIND_BY_EXTENSION = new Map(
  Object.entries(EXTENSIONS).flatMap(([kind, list]) =>
    list.split(" ").map((extension) => [extension, kind as AttachmentKind] as const),
  ),
);

/** The tile kind for a file: by extension first (a browser types `.ts` as
 *  video), then by the MIME type for names without a known extension. */
export function attachmentKind(name: string, contentType = ""): AttachmentKind {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  const byExtension = KIND_BY_EXTENSION.get(extension);
  if (byExtension) return byExtension;
  const mime = contentType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "text/csv" || mime.includes("spreadsheet") || mime.includes("excel")) return "spreadsheet";
  if (mime.includes("presentation") || mime.includes("powerpoint")) return "presentation";
  if (mime === "application/pdf" || mime.includes("word") || mime.startsWith("text/")) return "document";
  return "file";
}

/** Frees a thumbnail's object URL once its tile is gone. */
export function releasePreview(upload: Pick<RunUpload, "previewUrl">) {
  if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
}

/** The uploads left once the ones a send carried are gone. */
export function withoutSent(uploads: readonly RunUpload[], sent: readonly string[]): RunUpload[] {
  return uploads.filter((upload) => !(upload.id && sent.includes(upload.id)));
}

type FileSource = FileList | readonly File[];

/**
 * Drop and paste handlers for a composer surface: dropped files and pasted
 * files (a screenshot on the clipboard) join the uploads. A text paste and a
 * drag that carries no files pass through untouched. A file drop is claimed
 * even while `accepting` is off (a send in flight), because the browser's
 * default for one is to open the file; it just adds nothing then.
 */
export function attachmentIntake(addFiles: (files: FileSource) => unknown, accepting = true) {
  return {
    onDragOver(event: Pick<DragEvent, "preventDefault" | "dataTransfer">) {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = accepting ? "copy" : "none";
    },
    onDrop(event: Pick<DragEvent, "preventDefault" | "dataTransfer">) {
      if (event.dataTransfer.files.length === 0) return;
      event.preventDefault();
      if (accepting) void addFiles(event.dataTransfer.files);
    },
    onPaste(event: Pick<ClipboardEvent, "preventDefault" | "clipboardData">) {
      if (event.clipboardData.files.length === 0) return;
      event.preventDefault();
      if (accepting) void addFiles(event.clipboardData.files);
    },
  };
}

export function useRunUploads() {
  const [uploads, setUploads] = useState<RunUpload[]>([]);
  // Files the last pick, drop or paste could not add past the 10-file cap.
  const [leftOut, setLeftOut] = useState(0);
  // The committed list, for the callbacks that run after an await and for the
  // thumbnails still held when the composer unmounts (a thread switch).
  const live = useRef<readonly RunUpload[]>([]);
  useEffect(() => {
    live.current = uploads;
  }, [uploads]);
  useEffect(() => () => live.current.forEach(releasePreview), []);

  const patch = (localId: string, change: Partial<RunUpload>) =>
    setUploads((current) =>
      current.map((upload) => (upload.localId === localId ? { ...upload, ...change } : upload)),
    );

  const addFiles = async (files: FileSource) => {
    const available = Math.max(0, MAX_FILES - uploads.length);
    const all = Array.from(files);
    const selected = all.slice(0, available);
    setLeftOut(all.length - selected.length);
    const pending = selected.map((file) => {
      const kind = attachmentKind(file.name, file.type);
      const error = preflightFailure(file);
      return {
        localId: crypto.randomUUID(),
        id: null,
        name: file.name,
        sizeBytes: file.size,
        status: error ? ("error" as const) : ("uploading" as const),
        kind,
        previewUrl: kind === "image" ? URL.createObjectURL(file) : null,
        progress: 0,
        ...(error ? { error } : {}),
        file,
      };
    });
    setUploads((current) => [...current, ...pending.map(({ file: _file, ...item }) => item)]);
    await Promise.all(
      pending.map(async ({ file, ...item }) => {
        // Too big or empty: the backend would refuse it, so it is never sent.
        if (item.status === "error") return;
        let response: Response;
        try {
          const form = new FormData();
          form.set("file", file);
          response = await backendUpload("/api/uploads", form, (progress) =>
            patch(item.localId, { progress }),
          );
        } catch {
          patch(item.localId, { status: "error", error: uploadFailureReason(null) });
          return;
        }
        const body = (await response.json().catch(() => null)) as
          | (UploadResponse & { error?: unknown })
          | null;
        const uploadId = body?.upload?.id;
        if (response.ok && typeof uploadId === "string") {
          patch(item.localId, { id: uploadId, status: "ready", progress: 100 });
        } else {
          patch(item.localId, {
            status: "error",
            error: uploadFailureReason(response.status, body?.error),
          });
        }
      }),
    );
  };

  const remove = async (upload: RunUpload) => {
    releasePreview(upload);
    setLeftOut(0);
    setUploads((current) => current.filter((item) => item.localId !== upload.localId));
    if (upload.id) {
      await backendFetch(`/api/uploads/${upload.id}`, { method: "DELETE" }).catch(() => {});
    }
  };

  return {
    uploads,
    readyIds: uploads.flatMap((upload) =>
      upload.status === "ready" && upload.id ? [upload.id] : [],
    ),
    blocked: uploads.some((upload) => upload.status !== "ready"),
    /** What the composer says about its files, or null when there is nothing to say. */
    notice: uploadNotice(uploads, leftOut),
    addFiles,
    remove,
    /** Drops the uploads a send carried; anything added since stays for the next message. */
    clearAccepted: (sent: readonly string[]) => {
      for (const upload of live.current) {
        if (upload.id && sent.includes(upload.id)) releasePreview(upload);
      }
      setLeftOut(0);
      setUploads((current) => withoutSent(current, sent));
    },
  };
}
