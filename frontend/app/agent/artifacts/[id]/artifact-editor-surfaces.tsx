"use client";

import {
  RiAddLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiArrowDownLine,
  RiArrowUpLine,
  RiBold,
  RiDeleteBinLine,
  RiH1,
  RiH2,
  RiH3,
  RiItalic,
  RiLink,
  RiListOrdered,
  RiListUnordered,
  RiUnderline,
} from "@remixicon/react";
import type { ArtifactPresentationSlide, ArtifactWorkpieceKind } from "@skynet/agent-client";
import { artifactFidelityFor } from "@skynet/artifact-workspace";
import { type RefObject, useState } from "react";
import * as Table from "@/components/ui/table";
import type { WorkpieceEditorController } from "./artifact-editor-state";
import { sanitizeRichHtml } from "./artifact-editor-model";

/** The honest per-format note (single source of truth in ARTIFACT_FIDELITY):
 * what the canonical editor preserves and what it deliberately drops. Shown in
 * both the full-page editor and the session side pane. */
export function ArtifactFidelityNote({ kind }: { readonly kind: ArtifactWorkpieceKind }) {
  const fidelity = artifactFidelityFor(kind);
  return (
    <div className="max-w-2xl text-paragraph-xs text-text-soft-400">
      <p>
        {fidelity.summary} Original bytes stay immutable; edits save as a browser workpiece and
        export native or canonical files.
      </p>
      <p className="mt-1">
        <span className="text-success-base">Preserved:</span> {fidelity.preserved.join(", ")}.
      </p>
      <p className="mt-0.5">
        <span className="text-warning-base">Not preserved:</span> {fidelity.notPreserved.join(", ")}.
      </p>
    </div>
  );
}

type RichInlineTag = "em" | "h1" | "h2" | "h3" | "strong" | "u";
type RichCommand =
  | "bold"
  | "italic"
  | "underline"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "numberList";

function currentSelectionRange(editor: HTMLDivElement): Range | null {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  return range && editor.contains(range.commonAncestorContainer) ? range : null;
}

function selectContents(node: Node): void {
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.addRange(range);
}

function wrapRichSelection(editor: HTMLDivElement, tagName: RichInlineTag): void {
  editor.focus();
  const range = currentSelectionRange(editor);
  const wrapper = document.createElement(tagName);
  if (!range || range.collapsed) {
    wrapper.append(document.createElement("br"));
    editor.append(wrapper);
    return;
  }
  wrapper.append(range.extractContents());
  range.insertNode(wrapper);
  selectContents(wrapper);
}

function wrapRichList(editor: HTMLDivElement, tagName: "ol" | "ul"): void {
  editor.focus();
  const range = currentSelectionRange(editor);
  const list = document.createElement(tagName);
  const item = document.createElement("li");
  if (!range || range.collapsed) {
    item.append(document.createElement("br"));
    list.append(item);
    editor.append(list);
    selectContents(item);
    return;
  }
  item.append(range.extractContents());
  list.append(item);
  range.insertNode(list);
  selectContents(item);
}

function wrapRichLink(editor: HTMLDivElement, href: string): void {
  editor.focus();
  const range = currentSelectionRange(editor);
  const anchor = document.createElement("a");
  anchor.setAttribute("href", href);
  if (!range || range.collapsed) {
    anchor.textContent = href;
    (range ?? document.createRange()).insertNode?.(anchor);
    if (!range) editor.append(anchor);
    selectContents(anchor);
    return;
  }
  anchor.append(range.extractContents());
  range.insertNode(anchor);
  selectContents(anchor);
}

const RICH_INLINE_TAG: Record<Exclude<RichCommand, "bulletList" | "numberList">, RichInlineTag> = {
  bold: "strong",
  italic: "em",
  underline: "u",
  heading1: "h1",
  heading2: "h2",
  heading3: "h3",
};

const RICH_TOOLBAR: readonly (readonly [RichCommand, string, typeof RiBold])[] = [
  ["heading1", "Heading 1", RiH1],
  ["heading2", "Heading 2", RiH2],
  ["heading3", "Heading 3", RiH3],
  ["bold", "Bold", RiBold],
  ["italic", "Italic", RiItalic],
  ["underline", "Underline", RiUnderline],
  ["bulletList", "Bulleted list", RiListUnordered],
  ["numberList", "Numbered list", RiListOrdered],
];

function isSafeLinkHref(value: string): boolean {
  const href = value.trim().toLowerCase();
  return href.startsWith("https://") || href.startsWith("http://") || href.startsWith("mailto:");
}

export function RichDocumentSurface({
  editorRef,
  loading,
  onChange,
}: {
  readonly editorRef: RefObject<HTMLDivElement | null>;
  readonly loading: boolean;
  readonly onChange: (html: string) => void;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("https://");

  const emit = () => {
    const editor = editorRef.current;
    if (editor) onChange(sanitizeRichHtml(editor.innerHTML));
  };

  const runCommand = (command: RichCommand) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (command === "bulletList") wrapRichList(editor, "ul");
    else if (command === "numberList") wrapRichList(editor, "ol");
    else wrapRichSelection(editor, RICH_INLINE_TAG[command]);
    emit();
  };

  const applyLink = () => {
    const editor = editorRef.current;
    if (!editor || !isSafeLinkHref(linkValue)) return;
    wrapRichLink(editor, linkValue.trim());
    emit();
    setLinkOpen(false);
    setLinkValue("https://");
  };

  return (
    <>
      <p id="workpiece-rich-label" className="text-label-sm text-text-strong-950">
        Rich document
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-1 border-y border-stroke-soft-200 py-2">
        {RICH_TOOLBAR.map(([command, title, Icon]) => (
          <button
            key={command}
            type="button"
            title={title}
            aria-label={title}
            disabled={loading}
            onClick={() => runCommand(command)}
            className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950 disabled:opacity-40"
          >
            <Icon aria-hidden className="size-4" />
          </button>
        ))}
        <div className="mx-1 h-5 w-px bg-stroke-soft-200" aria-hidden />
        <button
          type="button"
          title="Insert link"
          aria-label="Insert link"
          aria-pressed={linkOpen}
          disabled={loading}
          onClick={() => setLinkOpen((open) => !open)}
          className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 hover:text-text-strong-950 aria-pressed:bg-bg-weak-50 aria-pressed:text-text-strong-950 disabled:opacity-40"
        >
          <RiLink aria-hidden className="size-4" />
        </button>
        {linkOpen && (
          <div className="flex items-center gap-1.5">
            <input
              value={linkValue}
              onChange={(event) => setLinkValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyLink();
                }
                if (event.key === "Escape") setLinkOpen(false);
              }}
              aria-label="Link URL"
              placeholder="https://"
              // biome-ignore lint/a11y/noAutofocus: focus the URL field the moment the link tool opens.
              autoFocus
              className="h-8 w-56 rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-2.5 text-label-xs text-text-strong-950 outline-none focus:border-stroke-strong-950"
            />
            <button
              type="button"
              onClick={applyLink}
              disabled={!isSafeLinkHref(linkValue)}
              className="h-8 rounded-lg bg-bg-strong-950 px-2.5 text-label-xs text-text-white-0 disabled:opacity-40"
            >
              Add
            </button>
          </div>
        )}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: contenteditable preserves inline document structure. */}
      <div
        ref={editorRef}
        id="workpiece-source"
        role="textbox"
        aria-labelledby="workpiece-rich-label"
        aria-disabled={loading}
        aria-multiline="true"
        contentEditable={!loading}
        tabIndex={loading ? -1 : 0}
        suppressContentEditableWarning
        onInput={() => onChange(sanitizeRichHtml(editorRef.current?.innerHTML ?? ""))}
        className="prose prose-sm mt-4 min-h-[420px] w-full flex-1 overflow-auto rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-6 text-text-strong-950 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 aria-disabled:opacity-50"
      />
    </>
  );
}

function columnLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

/** An editable grid over the first-worksheet cell values: lettered columns,
 * numbered rows, an active-cell value bar, and a single honest sheet tab. Values
 * only - formulas, extra worksheets, and formatting are not preserved (see the
 * fidelity note). */
export function SpreadsheetGridSurface({
  rows,
  onChange,
}: {
  readonly rows: readonly (readonly string[])[];
  readonly onChange: (rows: string[][]) => void;
}) {
  const [active, setActive] = useState<{ row: number; column: number }>({ row: 0, column: 0 });
  const rowCount = rows.length;
  const columnCount = rows[0]?.length ?? 0;
  const activeRow = Math.min(active.row, Math.max(0, rowCount - 1));
  const activeColumn = Math.min(active.column, Math.max(0, columnCount - 1));
  const activeValue = rows[activeRow]?.[activeColumn] ?? "";

  const updateCell = (rowIndex: number, columnIndex: number, next: string) =>
    onChange(
      rows.map((row, index) =>
        index === rowIndex ? row.with(columnIndex, next) : Array.from(row),
      ),
    );
  const addRow = () =>
    onChange([
      ...rows.map((row) => Array.from(row)),
      Array.from({ length: rows[0]?.length ?? 3 }, () => ""),
    ]);
  const addColumn = () => onChange(rows.map((row) => [...row, ""]));

  return (
    <section className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
      {/* Value bar: the active cell reference + its editable value, the way a
          real spreadsheet exposes the focused cell. */}
      <div className="flex items-center gap-2">
        <span className="inline-flex h-8 min-w-12 items-center justify-center rounded-lg border border-stroke-soft-200 bg-bg-weak-50 px-2 font-mono text-label-xs text-text-sub-600">
          {columnLabel(activeColumn)}
          {activeRow + 1}
        </span>
        <span className="font-mono text-label-xs text-text-soft-400" aria-hidden>
          fx
        </span>
        <input
          value={activeValue}
          onChange={(event) => updateCell(activeRow, activeColumn, event.currentTarget.value)}
          aria-label={`Value of cell ${columnLabel(activeColumn)}${activeRow + 1}`}
          placeholder="Empty cell"
          className="h-8 min-w-0 flex-1 rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["Row", addRow],
            ["Column", addColumn],
          ] as const
        ).map(([label, action]) => (
          <button
            key={label}
            type="button"
            onClick={action}
            className="inline-flex h-8 items-center gap-2 rounded-lg border border-stroke-soft-200 px-3 text-label-sm hover:bg-bg-weak-50"
          >
            <RiAddLine aria-hidden className="size-4" />
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-stroke-soft-200 bg-bg-white-0">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head className="w-12 min-w-12 bg-bg-weak-50 text-center" aria-label="Row" />
              {rows[0]?.map((_, columnIndex) => (
                <Table.Head key={columnIndex} className="min-w-32 text-center">
                  {columnLabel(columnIndex)}
                </Table.Head>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body spacing={0}>
            {rows.map((row, rowIndex) => (
              <Table.Row key={rowIndex}>
                <Table.Cell className="w-12 min-w-12 border-t border-stroke-soft-200 bg-bg-weak-50 p-0 text-center align-middle font-mono text-label-xs text-text-soft-400">
                  {rowIndex + 1}
                </Table.Cell>
                {row.map((cell, columnIndex) => {
                  const isActive = rowIndex === activeRow && columnIndex === activeColumn;
                  return (
                    <Table.Cell
                      key={`${rowIndex}-${columnIndex}`}
                      className="h-10 border-t border-stroke-soft-200 p-0"
                    >
                      <input
                        value={cell}
                        onFocus={() => setActive({ row: rowIndex, column: columnIndex })}
                        onChange={(event) =>
                          updateCell(rowIndex, columnIndex, event.currentTarget.value)
                        }
                        className={
                          isActive
                            ? "h-10 w-full bg-bg-white-0 px-3 text-paragraph-sm text-text-strong-950 outline-none ring-2 ring-inset ring-primary-base"
                            : "h-10 w-full bg-transparent px-3 text-paragraph-sm outline-none focus:bg-bg-weak-50"
                        }
                        aria-label={`Cell ${columnLabel(columnIndex)}${rowIndex + 1}`}
                      />
                    </Table.Cell>
                  );
                })}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </div>

      {/* Sheet tabs: a single honest tab - only the first worksheet is edited. */}
      <div className="flex items-center gap-1">
        <span className="inline-flex h-7 items-center rounded-lg border border-stroke-soft-200 bg-bg-weak-50 px-3 text-label-xs text-text-strong-950">
          Sheet 1
        </span>
        <span className="text-paragraph-xs text-text-soft-400">First worksheet, values only</span>
      </div>
    </section>
  );
}

function SlidePreviewCanvas({
  slide,
  index,
  total,
}: {
  readonly slide: ArtifactPresentationSlide;
  readonly index: number;
  readonly total: number;
}) {
  const bodyLines = slide.body.split("\n");
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs">
      <div className="bg-halftone pointer-events-none absolute inset-0 opacity-60" aria-hidden />
      <div className="relative flex h-full flex-col gap-3 p-6 sm:p-8">
        <h3 className="text-title-h5 text-text-strong-950 sm:text-title-h4">
          {slide.title || "Untitled slide"}
        </h3>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-auto">
          {slide.body.trim()
            ? bodyLines.map((line, lineIndex) => (
                <p key={lineIndex} className="text-paragraph-sm text-text-sub-600 sm:text-paragraph-md">
                  {line || " "}
                </p>
              ))
            : <p className="text-paragraph-sm text-text-soft-400">No body text yet.</p>}
        </div>
        <span className="absolute bottom-3 right-4 font-mono text-label-xs text-text-soft-400">
          {index + 1} / {total}
        </span>
      </div>
    </div>
  );
}

/** Structure-aware slide editor over the canonical presentation state (title,
 * body, and speaker notes per slide) with a rendered 16:9 preview and per-slide
 * navigation. Round-trips through the same revisioned workpiece state as every
 * other surface; the native PPTX export is derived from it. Slide visuals,
 * layouts, and media are out of scope (see the fidelity note). */
export function SlidesSurface({
  slides,
  loading,
  onChange,
}: {
  readonly slides: readonly ArtifactPresentationSlide[];
  readonly loading: boolean;
  readonly onChange: (slides: ArtifactPresentationSlide[]) => void;
}) {
  const [index, setIndex] = useState(0);
  const activeIndex = Math.min(index, Math.max(0, slides.length - 1));
  const active = slides[activeIndex];

  const clone = () => slides.map((slide) => ({ ...slide }));
  const patch = (position: number, next: Partial<ArtifactPresentationSlide>) =>
    onChange(
      slides.map((slide, current) =>
        current === position ? { ...slide, ...next } : { ...slide },
      ),
    );
  const addSlide = () => {
    onChange([...clone(), { title: `Slide ${slides.length + 1}`, body: "", notes: "" }]);
    setIndex(slides.length);
  };
  const removeSlide = (position: number) => {
    onChange(slides.filter((_, current) => current !== position).map((slide) => ({ ...slide })));
    setIndex((current) => Math.max(0, current > position ? current - 1 : current));
  };
  const move = (position: number, delta: number) => {
    const target = position + delta;
    if (target < 0 || target >= slides.length) return;
    const next = clone();
    const moved = next[position];
    const displaced = next[target];
    if (!moved || !displaced) return;
    next[position] = displaced;
    next[target] = moved;
    onChange(next);
    setIndex(target);
  };

  return (
    <section className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-label-sm text-text-strong-950">Slides ({slides.length})</p>
        <button
          type="button"
          onClick={addSlide}
          disabled={loading}
          className="inline-flex h-8 items-center gap-2 rounded-lg border border-stroke-soft-200 px-3 text-label-sm hover:bg-bg-weak-50 disabled:opacity-50"
        >
          <RiAddLine aria-hidden className="size-4" />
          Add slide
        </button>
      </div>

      {slides.length === 0 || !active ? (
        <p className="rounded-xl border border-dashed border-stroke-soft-200 px-4 py-8 text-center text-paragraph-sm text-text-sub-600">
          No slides yet. Add the first slide to start the deck.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-2">
          <SlidePreviewCanvas slide={active} index={activeIndex} total={slides.length} />

          {/* Per-slide navigation + slide-level controls. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setIndex(Math.max(0, activeIndex - 1))}
                disabled={activeIndex === 0}
                aria-label="Previous slide"
                title="Previous slide"
                className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-30"
              >
                <RiArrowLeftSLine aria-hidden className="size-5" />
              </button>
              <span className="min-w-16 text-center text-label-sm text-text-strong-950">
                Slide {activeIndex + 1}
              </span>
              <button
                type="button"
                onClick={() => setIndex(Math.min(slides.length - 1, activeIndex + 1))}
                disabled={activeIndex === slides.length - 1}
                aria-label="Next slide"
                title="Next slide"
                className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-30"
              >
                <RiArrowRightSLine aria-hidden className="size-5" />
              </button>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => move(activeIndex, -1)}
                disabled={loading || activeIndex === 0}
                aria-label={`Move slide ${activeIndex + 1} earlier`}
                title="Move earlier"
                className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-30"
              >
                <RiArrowUpLine aria-hidden className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => move(activeIndex, 1)}
                disabled={loading || activeIndex === slides.length - 1}
                aria-label={`Move slide ${activeIndex + 1} later`}
                title="Move later"
                className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-30"
              >
                <RiArrowDownLine aria-hidden className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => removeSlide(activeIndex)}
                disabled={loading}
                aria-label={`Delete slide ${activeIndex + 1}`}
                title="Delete slide"
                className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 hover:text-error-base disabled:opacity-30"
              >
                <RiDeleteBinLine aria-hidden className="size-4" />
              </button>
            </div>
          </div>

          {/* Filmstrip: jump between slides. */}
          {slides.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {slides.map((slide, position) => (
                <button
                  key={position}
                  type="button"
                  onClick={() => setIndex(position)}
                  aria-current={position === activeIndex}
                  title={slide.title || `Slide ${position + 1}`}
                  className={
                    position === activeIndex
                      ? "flex h-14 w-24 shrink-0 flex-col justify-between rounded-lg border-2 border-primary-base bg-bg-white-0 p-1.5 text-left"
                      : "flex h-14 w-24 shrink-0 flex-col justify-between rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-1.5 text-left hover:border-stroke-sub-300"
                  }
                >
                  <span className="font-mono text-[10px] text-text-soft-400">{position + 1}</span>
                  <span className="line-clamp-2 text-[10px] leading-tight text-text-sub-600">
                    {slide.title || "Untitled"}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Edit fields for the active slide. */}
          <label className="block text-label-xs text-text-sub-600">
            Title
            <input
              value={active.title}
              disabled={loading}
              onChange={(event) => patch(activeIndex, { title: event.currentTarget.value })}
              className="mt-1 h-9 w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 text-label-sm text-text-strong-950 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 disabled:opacity-50"
            />
          </label>
          <label className="block text-label-xs text-text-sub-600">
            Body
            <textarea
              value={active.body}
              disabled={loading}
              onChange={(event) => patch(activeIndex, { body: event.currentTarget.value })}
              className="mt-1 min-h-24 w-full resize-y rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-3 text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 disabled:opacity-50"
            />
          </label>
          <label className="block text-label-xs text-text-sub-600">
            Speaker notes
            <textarea
              value={active.notes ?? ""}
              disabled={loading}
              onChange={(event) => patch(activeIndex, { notes: event.currentTarget.value })}
              className="mt-1 min-h-16 w-full resize-y rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-3 text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 disabled:opacity-50"
            />
          </label>
        </div>
      )}
    </section>
  );
}

export function SourceSurface({
  label,
  loading,
  sheetTooLarge,
  spreadsheet,
  value,
  onChange,
}: {
  readonly label: string;
  readonly loading: boolean;
  readonly sheetTooLarge: boolean;
  readonly spreadsheet: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <>
      {sheetTooLarge && (
        <p className="mb-4 rounded-lg border border-warning-base bg-warning-lighter px-4 py-3 text-paragraph-sm text-warning-base">
          This sheet is larger than the browser grid limit, so it is open as CSV source.
        </p>
      )}
      <label htmlFor="workpiece-source" className="text-label-sm text-text-strong-950">
        {label}
      </label>
      <textarea
        id="workpiece-source"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={loading}
        spellCheck={!spreadsheet}
        className="mt-2 min-h-[420px] w-full flex-1 resize-y rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-4 font-mono text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 disabled:opacity-50"
      />
    </>
  );
}

/** The read-only Code view: the exact canonical serialization that a save
 * writes, so the rendered|Code toggle never fakes what is stored. */
export function WorkpieceCodeView({
  label,
  source,
}: {
  readonly label: string;
  readonly source: string;
}) {
  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col">
      <p className="text-label-sm text-text-strong-950">{label} source</p>
      <p className="mt-1 text-paragraph-xs text-text-soft-400">
        Read-only. This is exactly what a save writes; edit in the rendered view.
      </p>
      <pre className="mt-2 min-h-0 flex-1 overflow-auto rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-4 font-mono text-paragraph-xs text-text-strong-950">
        {source || "(empty)"}
      </pre>
    </div>
  );
}

/** The one surface switcher shared by the full-page editor and the side pane:
 * rendered structured surface per kind, or the read-only Code view. */
export function WorkpieceSurfaces({
  editor,
  viewMode,
}: {
  readonly editor: WorkpieceEditorController;
  readonly viewMode: "rendered" | "code";
}) {
  if (viewMode === "code") {
    return <WorkpieceCodeView label={editor.label} source={editor.canonicalSource()} />;
  }
  if (editor.isRich) {
    return (
      <RichDocumentSurface
        editorRef={editor.richEditorRef}
        loading={editor.loading}
        onChange={editor.onRichChange}
      />
    );
  }
  if (editor.isGrid) {
    return <SpreadsheetGridSurface rows={editor.rows} onChange={editor.setRows} />;
  }
  if (editor.isSlidesEditor) {
    return <SlidesSurface slides={editor.slides} loading={editor.loading} onChange={editor.setSlides} />;
  }
  return (
    <SourceSurface
      label={editor.label}
      loading={editor.loading}
      sheetTooLarge={editor.isSpreadsheet && editor.mode === "grid" && !editor.isGrid}
      spreadsheet={editor.isSpreadsheet}
      value={editor.value}
      onChange={editor.setSource}
    />
  );
}
