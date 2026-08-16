"use client";

import { RiArrowLeftLine, RiDownloadLine, RiSaveLine } from "@remixicon/react";
import {
  type ArtifactDescriptor,
  type ArtifactPresentationSlide,
  type ArtifactWorkpieceState,
  decodeWorkpieceResult,
} from "@skynet/agent-client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import {
  artifactEditorMode,
  isSheetWithinGridLimit,
  parseCsv,
  pdfTextTemplate,
  presentationTemplate,
  richDocumentTemplate,
  sanitizeRichHtml,
  serializeCsv,
  stateValue,
} from "./artifact-editor-model";
import {
  RichDocumentSurface,
  SourceSurface,
  SpreadsheetGridSurface,
} from "./artifact-editor-surfaces";

import { artifactActionContractFor } from "@skynet/artifact-workspace";

type Mode = ReturnType<typeof artifactEditorMode>;

function labelForMode(mode: Mode): string {
  switch (mode) {
    case "grid":
      return "Spreadsheet grid";
    case "sheet-source":
      return "Spreadsheet source";
    case "rich-document":
      return "Rich document";
    case "source-document":
      return "Document source";
    case "slides-json":
      return "Presentation slides";
    case "pdf-text":
      return "PDF text";
  }
}

function parseSlidesJson(value: string): readonly ArtifactPresentationSlide[] {
  const parsed = JSON.parse(value) as unknown;
  const slides = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "slides" in parsed
    ? (parsed as { slides: unknown }).slides
    : null;
  if (!Array.isArray(slides)) throw new Error("slides must be an array or { slides } object");
  return slides.map((slide, index) => {
    if (!slide || typeof slide !== "object" || Array.isArray(slide)) {
      throw new Error(`slide ${index + 1} must be an object`);
    }
    const item = slide as Record<string, unknown>;
    if (typeof item.title !== "string" || typeof item.body !== "string") {
      throw new Error(`slide ${index + 1} needs string title and body`);
    }
    return {
      title: item.title,
      body: item.body,
      ...(typeof item.notes === "string" ? { notes: item.notes } : {}),
    };
  });
}

function stateForMode(mode: Mode, value: string): ArtifactWorkpieceState {
  switch (mode) {
    case "grid":
    case "sheet-source":
      return { csv: value };
    case "rich-document":
      return { html: value };
    case "slides-json":
      return { slides: parseSlidesJson(value) };
    case "pdf-text":
      return { pdfText: value };
    case "source-document":
      return { text: value };
  }
}

function spreadsheetRows(value: string): string[][] {
  const parsed = parseCsv(value);
  if (!isSheetWithinGridLimit(parsed)) return parsed;
  const width = Math.max(3, ...parsed.map((row) => row.length));
  return parsed.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")]);
}

export function ArtifactEditor({ artifact }: { readonly artifact: ArtifactDescriptor }) {
  const workpiece = artifact.workpiece;
  const actionContract = artifactActionContractFor(artifact);
  const mode = artifactEditorMode(artifact);
  const richEditorRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(workpiece?.state_revision ?? 0);
  const [value, setValue] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [rows, setRows] = useState<string[][]>([["", "", ""]]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isGrid = mode === "grid" && isSheetWithinGridLimit(rows);
  const editorMode = mode === "grid" && !isGrid ? "sheet-source" : mode;
  const isRich = editorMode === "rich-document";
  const isSpreadsheet = workpiece?.kind === "spreadsheet";

  const normalizeValue = useCallback(
    (next: string) => (isRich ? sanitizeRichHtml(next) : next),
    [isRich],
  );
  const setEditorValue = useCallback((next: string) => {
    setValue(next);
    if (richEditorRef.current) richEditorRef.current.innerHTML = next;
  }, []);

  const load = useCallback(async () => {
    if (!workpiece) return;
    setLoading(true);
    setError(null);
    try {
      const stateResponse = await backendFetch(workpiece.state_url, { cache: "no-store" });
      if (!stateResponse.ok) throw new Error(`state request failed (${stateResponse.status})`);
      const result = decodeWorkpieceResult(await stateResponse.json());
      if (!result) throw new Error("state response was invalid");
      let text = stateValue(result);
      if (text === null && !isRich && mode !== "grid") {
        const sourceResponse = await backendFetch(artifact.preview_url, { cache: "no-store" });
        if (!sourceResponse.ok) throw new Error(`source request failed (${sourceResponse.status})`);
        text = await sourceResponse.text();
      }
      if (text === null && isRich) text = richDocumentTemplate(artifact.name);
      if (text === null && mode === "slides-json") text = presentationTemplate(artifact.name);
      if (text === null && mode === "pdf-text") text = pdfTextTemplate(artifact.name);
      const normalized = normalizeValue(text ?? "");
      setRevision(result.workpiece.state_revision);
      setEditorValue(normalized);
      setSavedValue(normalized);
      if (isSpreadsheet) setRows(spreadsheetRows(normalized));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workpiece could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [
    artifact.name,
    artifact.preview_url,
    isRich,
    isSpreadsheet,
    mode,
    normalizeValue,
    setEditorValue,
    workpiece,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentValue = () => {
    if (isGrid) return serializeCsv(rows);
    if (isRich) return sanitizeRichHtml(richEditorRef.current?.innerHTML ?? value);
    return value;
  };

  async function save() {
    if (!workpiece) return;
    setSaving(true);
    setError(null);
    const nextValue = currentValue();
    let state: ArtifactWorkpieceState;
    try {
      state = stateForMode(editorMode, nextValue);
    } catch (cause) {
      setSaving(false);
      setError(cause instanceof Error ? cause.message : "The workpiece state is invalid.");
      return;
    }
    try {
      const response = await backendFetch(workpiece.state_url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_revision: revision, state }),
      });
      const result = decodeWorkpieceResult(await response.json());
      if (response.status === 409 && result) {
        const latest = normalizeValue(stateValue(result) ?? "");
        setRevision(result.workpiece.state_revision);
        setEditorValue(latest);
        setSavedValue(latest);
        if (isSpreadsheet) setRows(spreadsheetRows(latest));
        setError("A newer edit was saved. The latest revision has been loaded.");
        return;
      }
      if (!response.ok || !result) throw new Error(`save failed (${response.status})`);
      setRevision(result.workpiece.state_revision);
      setEditorValue(nextValue);
      setSavedValue(nextValue);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workpiece could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!workpiece) return null;
  const label = labelForMode(editorMode);
  const dirty = currentValue() !== savedValue;

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-[1120px] flex-1 flex-col px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/agent/artifacts"
            className="inline-flex items-center gap-1.5 text-label-sm text-text-sub-600 outline-none hover:text-text-strong-950 focus-visible:underline"
          >
            <RiArrowLeftLine aria-hidden className="size-4" />
            Artifacts
          </Link>
          <h1 className="mt-3 text-display-sm text-text-strong-950">{artifact.name}</h1>
          <p className="mt-1 text-paragraph-sm text-text-sub-600">
            {label} · revision {revision}
          </p>
          {actionContract.edit?.mode === "companion" && (
            <p className="mt-2 max-w-2xl text-paragraph-xs text-text-soft-400">
              Original bytes stay immutable. Edits are saved as a browser workpiece and can export
              either native Office/PDF files or canonical companion formats.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actionContract.actions.includes("download") && (
            <a
              href={artifact.download_url}
              download={artifact.name}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 text-label-sm text-text-sub-600 outline-none hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2"
            >
              <RiDownloadLine aria-hidden className="size-4" /> Original
            </a>
          )}
          {actionContract.actions.includes("export") && (
            <a
              href={workpiece.export_url}
              download
              aria-disabled={loading}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 text-label-sm text-text-sub-600 outline-none hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RiDownloadLine aria-hidden className="size-4" /> Export
            </a>
          )}
          {actionContract.actions.includes("edit") && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={loading || saving || !dirty}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-bg-strong-950 px-4 text-label-sm text-text-white-0 outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stroke-strong-950 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RiSaveLine aria-hidden className="size-4" /> {saving ? "Saving..." : "Save"}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-error-base bg-error-lighter px-4 py-3 text-paragraph-sm text-error-base"
        >
          {error}
        </p>
      )}
      {isRich && (
        <RichDocumentSurface editorRef={richEditorRef} loading={loading} onChange={setValue} />
      )}
      {isGrid && <SpreadsheetGridSurface rows={rows} onChange={setRows} />}
      {!isRich && !isGrid && (
        <SourceSurface
          label={label}
          loading={loading}
          sheetTooLarge={isSpreadsheet && !isSheetWithinGridLimit(rows)}
          spreadsheet={isSpreadsheet}
          value={value}
          onChange={(next) => {
            setValue(next);
            if (isSpreadsheet) setRows(spreadsheetRows(next));
          }}
        />
      )}
    </main>
  );
}
