"use client";

import {
  type ArtifactDescriptor,
  type ArtifactWorkpieceDescriptor,
  type ArtifactWorkpieceState,
  decodeWorkpieceResult,
  type PresentationDeck,
} from "@skynet/agent-client";
import {
  artifactActionContractFor,
  coercePresentationState,
  migrateSlidesToDeck,
} from "@skynet/artifact-workspace";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";
import type { OrgChange } from "@/lib/org-changes";
import {
  type ArtifactEditorMode,
  artifactEditorMode,
  isSheetWithinGridLimit,
  parseCsv,
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

/** Parse deck JSON (a v2 `{deck}` / bare deck, a v1 `{slides}`, or a bare slide
 * array) into a validated canonical deck, throwing on invalid input so a bad
 * Code-view edit surfaces as a save error instead of a silent drop. */
export function parseDeckJson(value: string): PresentationDeck {
  const parsed = JSON.parse(value) as unknown;
  const state = coercePresentationState(parsed);
  if (!state) throw new Error("presentation state must be a valid deck or slide array");
  return state.deck;
}

/** One canonical string form of a deck, used for both the saved baseline and the
 * dirty check so the structured editor and the wire agree bit for bit. */
export function serializeDeck(deck: PresentationDeck): string {
  return JSON.stringify(deck);
}

function deckFromValue(value: string): PresentationDeck | null {
  try {
    return parseDeckJson(value);
  } catch {
    return null;
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
      return { deck: parseDeckJson(value) };
    case "pdf-text":
      return { pdfText: value };
    case "source-document":
      return { text: value };
  }
}

/** A published PDF is byte-authoritative: its content lives in the immutable
 * source bytes and it carries no editable `pdfText` state (page reorder/delete
 * are its only revisions). Detect it so the loader never dumps raw bytes into
 * the text editor and the surface renders an embedded preview instead. The
 * `pdf-text` editor stays only for text-authored PDFs (state carries pdfText). */
export function isByteAuthoritativePdf(
  mode: ArtifactEditorMode,
  stateText: string | null,
): boolean {
  return mode === "pdf-text" && stateText === null;
}

/** Reload gate for the page-wide artifact invalidation stream: reload an open
 * workpiece only when its own change signal arrives and the local editor is idle
 * and clean. A dirty editor is never clobbered - its now-stale revision surfaces
 * the existing 409 conflict path on the next save, never a silent overwrite. */
export function shouldReloadOnArtifactSignal(
  change: OrgChange,
  artifactId: string,
  status: { readonly loading: boolean; readonly saving: boolean; readonly dirty: boolean },
): boolean {
  if (change.type !== "artifact" || change.artifactId !== artifactId) return false;
  return !status.loading && !status.saving && !status.dirty;
}

/** Append a monotonic cache-bust so an embedded byte-PDF <object> refetches its
 * bytes when a new revision lands, instead of showing the stale cached render. */
function withCacheBust(url: string, nonce: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}v=${nonce}`;
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
  /** A byte-authoritative (published) PDF: render the embedded preview, never
   * the text editor or raw bytes. */
  readonly pdfEmbed: boolean;
  /** The embed source for a byte-PDF, cache-busted per reload so a new revision
   * renders. */
  readonly pdfPreviewUrl: string;
  readonly sizeBytes: number;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly revision: number;
  readonly dirty: boolean;
  readonly value: string;
  readonly rows: string[][];
  /** The current deck for the presentation editor, or null before load. */
  readonly deck: PresentationDeck | null;
  readonly richEditorRef: RefObject<HTMLDivElement | null>;
  readonly setRows: (rows: string[][]) => void;
  readonly setDeck: (deck: PresentationDeck) => void;
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
  const [deck, setDeck] = useState<PresentationDeck | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A published PDF has no editable text state; render its bytes as an embed.
  const [pdfEmbed, setPdfEmbed] = useState(false);
  // Bumped on every successful load so the embedded byte-PDF <object> refetches.
  const [reloadNonce, setReloadNonce] = useState(0);
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
      // A byte-authoritative PDF (published, no pdfText state) must NEVER fetch
      // its bytes into the text editor - it renders as an embedded preview.
      const byteAuthoritativePdf = isByteAuthoritativePdf(mode, text);
      setPdfEmbed(byteAuthoritativePdf);
      if (text === null && !isRich && mode !== "grid" && mode !== "pdf-text") {
        const sourceResponse = await backendFetch(artifact.preview_url, { cache: "no-store" });
        if (!sourceResponse.ok) throw new Error(`source request failed (${sourceResponse.status})`);
        text = await sourceResponse.text();
      }
      if (text === null && isRich) text = richDocumentTemplate(artifact.name);
      if (text === null && mode === "slides-json") text = presentationTemplate(artifact.name);
      const normalized = normalizeValue(text ?? "");
      setRevision(result.workpiece.state_revision);
      setReloadNonce((nonce) => nonce + 1);
      if (isSlidesEditor) {
        const parsedDeck = deckFromValue(normalized) ?? migrateSlidesToDeck([]);
        const canonical = serializeDeck(parsedDeck);
        setDeck(parsedDeck);
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
    if (isSlidesEditor) return deck ? serializeDeck(deck) : savedValue;
    return value;
  }, [deck, isGrid, isRich, isSlidesEditor, rows, savedValue, value]);

  const canonicalSource = useCallback(() => {
    if (isSlidesEditor) return deck ? JSON.stringify(deck, null, 2) : "";
    return currentValue();
  }, [currentValue, deck, isSlidesEditor]);

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
          const parsedDeck = deckFromValue(latest) ?? migrateSlidesToDeck([]);
          const canonical = serializeDeck(parsedDeck);
          setDeck(parsedDeck);
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

  // Live reload: when the agent revises this workpiece mid-run, the page-wide
  // artifact invalidation stream reloads the latest revision in place - but only
  // while the local editor is idle and clean, so an in-progress edit is never
  // clobbered. A byte-PDF embed refreshes through the bumped cache-bust nonce.
  useOrgChanges((change) => {
    if (shouldReloadOnArtifactSignal(change, artifact.id, { loading, saving, dirty })) void load();
  });

  const setRowsTracked = useCallback(
    (next: string[][]) => {
      setRows(next);
      bump();
    },
    [bump],
  );
  const setDeckTracked = useCallback(
    (next: PresentationDeck) => {
      setDeck(next);
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
    pdfEmbed,
    pdfPreviewUrl: pdfEmbed ? withCacheBust(artifact.preview_url, reloadNonce) : artifact.preview_url,
    sizeBytes: artifact.size_bytes,
    loading,
    saving,
    error,
    revision,
    dirty,
    value,
    rows,
    deck,
    richEditorRef,
    setRows: setRowsTracked,
    setDeck: setDeckTracked,
    setSource,
    onRichChange,
    save,
    currentValue,
    canonicalSource,
  };
}
