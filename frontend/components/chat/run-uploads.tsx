"use client";

import { RiCloseLine, RiErrorWarningLine, RiFileLine, RiLoader4Line } from "@remixicon/react";
import { useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";

export type RunUpload = {
  readonly localId: string;
  readonly id: string | null;
  readonly name: string;
  readonly sizeBytes: number;
  readonly status: "uploading" | "ready" | "error";
};

type UploadResponse = {
  upload?: { id?: unknown; name?: unknown; size_bytes?: unknown };
};

const MAX_FILES = 10;

export function useRunUploads() {
  const [uploads, setUploads] = useState<RunUpload[]>([]);

  const addFiles = async (files: FileList | readonly File[]) => {
    const available = Math.max(0, MAX_FILES - uploads.length);
    const selected = Array.from(files).slice(0, available);
    const pending = selected.map((file) => ({
      localId: crypto.randomUUID(),
      id: null,
      name: file.name,
      sizeBytes: file.size,
      status: "uploading" as const,
      file,
    }));
    setUploads((current) => [...current, ...pending.map(({ file: _file, ...item }) => item)]);
    await Promise.all(
      pending.map(async ({ file, ...item }) => {
        try {
          const form = new FormData();
          form.set("file", file);
          const response = await backendFetch("/api/uploads", { method: "POST", body: form });
          if (!response.ok) throw new Error(`upload failed (${response.status})`);
          const body = (await response.json()) as UploadResponse;
          const uploadId = body.upload?.id;
          if (typeof uploadId !== "string") throw new Error("upload id missing");
          setUploads((current) =>
            current.map((upload) =>
              upload.localId === item.localId
                ? { ...upload, id: uploadId, status: "ready" }
                : upload,
            ),
          );
        } catch {
          setUploads((current) =>
            current.map((upload) =>
              upload.localId === item.localId ? { ...upload, status: "error" } : upload,
            ),
          );
        }
      }),
    );
  };

  const remove = async (upload: RunUpload) => {
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
    addFiles,
    remove,
    clearAccepted: () => setUploads([]),
  };
}

export function RunUploadChips({
  uploads,
  onRemove,
}: {
  readonly uploads: readonly RunUpload[];
  readonly onRemove: (upload: RunUpload) => void;
}) {
  if (uploads.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 px-1 pb-1.5" aria-label="Attached files">
      {uploads.map((upload) => (
        <li
          key={upload.localId}
          className="border-stroke-soft-200 bg-bg-weak-50 text-text-sub-600 inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-label-xs"
        >
          {upload.status === "uploading" ? (
            <RiLoader4Line className="size-3.5 animate-spin" aria-label="Uploading" />
          ) : upload.status === "error" ? (
            <RiErrorWarningLine className="text-error-base size-3.5" aria-label="Upload failed" />
          ) : (
            <RiFileLine className="size-3.5" aria-hidden />
          )}
          <span className="max-w-52 truncate">{upload.name}</span>
          <button
            type="button"
            aria-label={`Remove ${upload.name}`}
            onClick={() => onRemove(upload)}
            className="hover:text-text-strong-950 rounded"
          >
            <RiCloseLine className="size-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
