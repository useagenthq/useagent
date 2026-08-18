"use client";

import {
  type ArtifactDescriptor,
  type ArtifactPresentationSlide,
  type ArtifactWorkpieceDescriptor,
  type ArtifactWorkpieceState,
  decodeWorkpieceResult,
} from "@skynet/agent-client";
import { artifactActionContractFor } from "@skynet/artifact-workspace";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import {
  type ArtifactEditorMode,
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

/** Debounce before an auto-save fires, matching the "quiet Saved indicator"
 * reference: keystrokes coalesce into ONE revisioned save, never a save-per-key. */
const AUTOSAVE_DELAY_MS = 800;

export function labelForMode(mode: ArtifactEditorMode): string {
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

export function parseSlidesJson(value: string): readonly ArtifactPresentationSlide[] {
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

/** One canonical string form of a deck, used for both the saved baseline and the
 * dirty check so the structured editor and the wire agree bit for bit. */
export function serializeSlides(slides: readonly ArtifactPresentationSlide[]): string {
  return JSON.stringify({
    slides: slides.map((slide) => ({
      title: slide.title,
      body: slide.body,
      ...(slide.notes ? { notes: slide.notes } : {}),
    })),
  });
}

function slidesFromValue(value: string): ArtifactPresentationSlide[] {
  try {
    return [...parseSlidesJson(value)];
  } catch {
    return [];
  }
}

function stateForMode(mode: ArtifactEditorMode, value: string): ArtifactWorkpieceState {
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

/** The one editing state machine for a canonical workpiece: loads the current
 * revision, tracks the structured surface value, and saves with optimistic
 * concurrency (409 -> reload latest, never a silent overwrite). Shared by the
 * full-page editor and the session side-pane so there is ONE state model. */
export interface WorkpieceEditorController {
  readonly workpiece: ArtifactWorkpieceDescriptor | null;
  readonly actionContract: ReturnType<typeof artifactActionContractFor>;
  readonly mode: ArtifactEditorMode;
  readonly editorMode: ArtifactEditorMode;
  readonly label: string;
  readonly isGrid: boolean;
  readonly isRich: boolean;
  readonly isSlidesEditor: boolean;
  readonly isSpreadsheet: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly revision: number;
  readonly dirty: boolean;
  readonly value: string;
  readonly rows: string[][];
  readonly slides: ArtifactPresentationSlide[];
  readonly richEditorRef: RefObject<HTMLDivElement | null>;
  readonly setRows: (rows: string[][]) => void;
  readonly setSlides: (slides: ArtifactPresentationSlide[]) => void;
  readonly setSource: (value: string) => void;
  readonly onRichChange: (html: string) => void;
  readonly save: () => Promise<void>;
  readonly currentValue: () => string;
  /** Human-readable canonical serialization for the read-only Code view. */
  readonly canonicalSource: () => string;
}

export function useWorkpieceEditor(
  artifact: ArtifactDescriptor,
  options: { readonly autosave?: boolean } = {},
): WorkpieceEditorController {
  const autosave = options.autosave ?? false;
  const workpiece = artifact.workpiece;
  const actionContract = artifactActionContractFor(artifact);
  const mode = artifactEditorMode(artifact);
  const richEditorRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(workpiece?.state_revision ?? 0);
  const [value, setValue] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [rows, setRows] = useState<string[][]>([["", "", ""]]);
  const [slides, setSlides] = useState<ArtifactPresentationSlide[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by every structured-surface edit so the auto-save effect can debounce
  // on real changes without recomputing derived state per keystroke.
  const [changeNonce, setChangeNonce] = useState(0);
  const bump = useCallback(() => setChangeNonce((nonce) => nonce + 1), []);

  const isGrid = mode === "grid" && isSheetWithinGridLimit(rows);
  const editorMode = mode === "grid" && !isGrid ? "sheet-source" : mode;
  const isRich = editorMode === "rich-document";
  const isSlidesEditor = editorMode === "slides-json";
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
      if (isSlidesEditor) {
        const parsed = slidesFromValue(normalized);
        const canonical = serializeSlides(parsed);
        setSlides(parsed);
        setValue(canonical);
        setSavedValue(canonical);
      } else {
        setEditorValue(normalized);
        setSavedValue(normalized);
        if (isSpreadsheet) setRows(spreadsheetRows(normalized));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workpiece could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [
    artifact.name,
    artifact.preview_url,
    isRich,
    isSlidesEditor,
    isSpreadsheet,
    mode,
    normalizeValue,
    setEditorValue,
    workpiece,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentValue = useCallback(() => {
    if (isGrid) return serializeCsv(rows);
    if (isRich) return sanitizeRichHtml(richEditorRef.current?.innerHTML ?? value);
    if (isSlidesEditor) return serializeSlides(slides);
    return value;
  }, [isGrid, isRich, isSlidesEditor, rows, slides, value]);

  const canonicalSource = useCallback(() => {
    if (isSlidesEditor) {
      try {
        return JSON.stringify({ slides }, null, 2);
      } catch {
        return serializeSlides(slides);
      }
    }
    return currentValue();
  }, [currentValue, isSlidesEditor, slides]);

  const save = useCallback(async () => {
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
        if (isSlidesEditor) {
          const parsed = slidesFromValue(latest);
          const canonical = serializeSlides(parsed);
          setSlides(parsed);
          setValue(canonical);
          setSavedValue(canonical);
        } else {
          setEditorValue(latest);
          setSavedValue(latest);
          if (isSpreadsheet) setRows(spreadsheetRows(latest));
        }
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
  }, [
    currentValue,
    editorMode,
    isSlidesEditor,
    isSpreadsheet,
    normalizeValue,
    revision,
    setEditorValue,
    workpiece,
  ]);

  const dirty = currentValue() !== savedValue;
  const editable = !!actionContract.edit;

  // Debounced auto-save: opt-in (the side pane), off for the full-page editor
  // which keeps its manual Save button. The effect re-runs cheaply on every
  // render but only schedules a timer while dirty, so keystrokes coalesce into
  // one revisioned PATCH and a conflict still surfaces the existing 409 handling.
  useEffect(() => {
    if (!autosave || !editable || loading || saving) return;
    if (currentValue() === savedValue) return;
    const timer = setTimeout(() => {
      void save();
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autosave, editable, loading, saving, savedValue, changeNonce, currentValue, save]);

  const setRowsTracked = useCallback(
    (next: string[][]) => {
      setRows(next);
      bump();
    },
    [bump],
  );
  const setSlidesTracked = useCallback(
    (next: ArtifactPresentationSlide[]) => {
      setSlides(next);
      bump();
    },
    [bump],
  );
  const setSource = useCallback(
    (next: string) => {
      setValue(next);
      if (isSpreadsheet) setRows(spreadsheetRows(next));
      bump();
    },
    [bump, isSpreadsheet],
  );
  const onRichChange = useCallback(
    (html: string) => {
      setValue(html);
      bump();
    },
    [bump],
  );

  return {
    workpiece,
    actionContract,
    mode,
    editorMode,
    label: labelForMode(editorMode),
    isGrid,
    isRich,
    isSlidesEditor,
    isSpreadsheet,
    loading,
    saving,
    error,
    revision,
    dirty,
    value,
    rows,
    slides,
    richEditorRef,
    setRows: setRowsTracked,
    setSlides: setSlidesTracked,
    setSource,
    onRichChange,
    save,
    currentValue,
    canonicalSource,
  };
}
