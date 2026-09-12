"use client";

import { RiUploadCloud2Line } from "@remixicon/react";
import { useRef, useState } from "react";
import { cx } from "@/utils/cx";
import { KnowledgeUploadError, uploadKnowledgeDocument } from "./knowledge-api";
import {
  KNOWLEDGE_UPLOAD_ACCEPT,
  KNOWLEDGE_UPLOAD_HINT,
  type UploadOutcome,
  uploadOutcomeCopy,
  validateKnowledgeUpload,
} from "./knowledge-upload-rules";

interface FileLine {
  readonly key: string;
  readonly name: string;
  readonly outcome: UploadOutcome;
}

/**
 * File drop for Knowledge: .md and .txt are read as-is, .pdf through the
 * backend text extractor, all through the same ingest as a pasted note. Files
 * are sent one at a time and every outcome is stated under the control - an
 * ingest that stored nothing (dropped, deferred) is never shown as a save.
 */
export function KnowledgeUploadDrop({
  folder,
  onIngested,
}: {
  folder: string;
  onIngested: () => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [lines, setLines] = useState<FileLine[]>([]);
  const [busy, setBusy] = useState(false);

  const setOutcome = (key: string, outcome: UploadOutcome) =>
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, outcome } : line)));

  async function accept(files: FileList | File[]) {
    if (busy) return;
    const queue: { key: string; file: File }[] = [];
    const rejected: FileLine[] = [];
    for (const file of Array.from(files)) {
      const key = `${file.name}:${file.size}:${Date.now()}`;
      const problem = validateKnowledgeUpload(file);
      if (problem) {
        rejected.push({ key, name: problem, outcome: { phase: "failed", code: "local" } });
      } else {
        queue.push({ key, file });
      }
    }
    setLines([
      ...rejected,
      ...queue.map(({ key, file }) => ({ key, name: file.name, outcome: { phase: "sending" } as const })),
    ]);
    if (queue.length === 0) return;
    setBusy(true);
    let stored = false;
    for (const { key, file } of queue) {
      try {
        const result = await uploadKnowledgeDocument(file, folder);
        setOutcome(key, { phase: "done", result });
        if (result.status === "stored") stored = true;
      } catch (error) {
        setOutcome(key, {
          phase: "failed",
          code: error instanceof KnowledgeUploadError ? error.code : null,
        });
      }
    }
    setBusy(false);
    if (stored) await onIngested();
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-label="Add documents to Knowledge"
        aria-busy={busy}
        data-testid="knowledge-upload-drop"
        onClick={() => !busy && inputRef.current?.click()}
        onKeyDown={(event) => {
          if (!busy && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          if (event.dataTransfer.files.length > 0) void accept(event.dataTransfer.files);
        }}
        className={cx(
          "flex items-center gap-3 rounded-2xl border-2 border-dashed px-4 py-3 outline-none transition-colors duration-200",
          busy ? "cursor-progress" : "cursor-pointer hover:border-border-button-active",
          dragOver
            ? "border-border-button-active bg-background-secondary-default"
            : "border-border-checkbox-default bg-background-primary-default",
          "focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={KNOWLEDGE_UPLOAD_ACCEPT}
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            const files = event.target.files;
            event.target.value = "";
            if (files && files.length > 0) void accept(files);
          }}
        />
        <RiUploadCloud2Line aria-hidden className="size-5 shrink-0 text-foreground-icon-secondary" />
        <div className="min-w-0">
          <p className="text-body-2-medium text-text-primary">
            {busy ? "Adding documents…" : "Drop documents here, or click to choose"}
          </p>
          <p className="text-caption-1-regular text-text-tertiary">{KNOWLEDGE_UPLOAD_HINT}</p>
        </div>
      </div>
      {lines.length > 0 && (
        <ul aria-live="polite" className="flex flex-col gap-1 px-1">
          {lines.map((line) => (
            <li
              key={line.key}
              className={cx(
                "text-caption-1-regular",
                line.outcome.phase === "failed" ? "text-text-error-primary" : "text-text-secondary",
              )}
            >
              {line.outcome.phase === "failed" && line.outcome.code === "local"
                ? line.name
                : uploadOutcomeCopy(line.name, line.outcome)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
