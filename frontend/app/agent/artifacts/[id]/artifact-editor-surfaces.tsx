"use client";

import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowUpLine,
  RiBold,
  RiDeleteBinLine,
  RiH1,
  RiH2,
  RiItalic,
} from "@remixicon/react";
import type { ArtifactPresentationSlide } from "@skynet/agent-client";
import type { RefObject } from "react";
import * as Table from "@/components/ui/table";
import { sanitizeRichHtml } from "./artifact-editor-model";

type RichCommand = "bold" | "heading1" | "heading2" | "italic";

function wrapRichSelection(editor: HTMLDivElement, tagName: "em" | "h1" | "h2" | "strong"): void {
  editor.focus();
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const wrapper = document.createElement(tagName);
  if (!range || !editor.contains(range.commonAncestorContainer) || range.collapsed) {
    wrapper.append(document.createElement("br"));
    editor.append(wrapper);
    return;
  }
  wrapper.append(range.extractContents());
  range.insertNode(wrapper);
  selection?.removeAllRanges();
  const nextRange = document.createRange();
  nextRange.selectNodeContents(wrapper);
  selection?.addRange(nextRange);
}

function richTag(command: RichCommand): "em" | "h1" | "h2" | "strong" {
  switch (command) {
    case "bold":
      return "strong";
    case "italic":
      return "em";
    case "heading1":
      return "h1";
    case "heading2":
      return "h2";
  }
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
  const runCommand = (command: RichCommand) => {
    const editor = editorRef.current;
    if (!editor) return;
    wrapRichSelection(editor, richTag(command));
    onChange(sanitizeRichHtml(editor.innerHTML));
  };

  return (
    <>
      <p id="workpiece-rich-label" className="mt-6 text-label-sm text-text-strong-950">
        Rich document
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-2 border-y border-stroke-soft-200 py-2">
        {(
          [
            ["heading1", "Heading 1", RiH1],
            ["heading2", "Heading 2", RiH2],
            ["bold", "Bold", RiBold],
            ["italic", "Italic", RiItalic],
          ] as const
        ).map(([command, title, Icon]) => (
          <button
            key={command}
            type="button"
            title={title}
            onClick={() => runCommand(command)}
            className="grid size-8 place-items-center rounded-lg hover:bg-bg-weak-50"
          >
            <Icon aria-hidden className="size-4" />
          </button>
        ))}
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
        className="prose prose-sm mt-4 min-h-[520px] w-full flex-1 overflow-auto rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-6 text-text-strong-950 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 aria-disabled:opacity-50"
      />
    </>
  );
}

export function SpreadsheetGridSurface({
  rows,
  onChange,
}: {
  readonly rows: readonly (readonly string[])[];
  readonly onChange: (rows: string[][]) => void;
}) {
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
    <section className="mt-6 flex min-h-0 flex-1 flex-col gap-3">
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
      <Table.Root className="max-h-[580px] rounded-xl border border-stroke-soft-200 bg-bg-white-0">
        <Table.Header>
          <Table.Row>
            {rows[0]?.map((_, columnIndex) => (
              <Table.Head key={columnIndex} className="min-w-32">
                {String.fromCharCode(65 + columnIndex)}
              </Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body spacing={0}>
          {rows.map((row, rowIndex) => (
            <Table.Row key={rowIndex}>
              {row.map((cell, columnIndex) => (
                <Table.Cell
                  key={`${rowIndex}-${columnIndex}`}
                  className="h-10 border-t border-stroke-soft-200 p-0"
                >
                  <input
                    value={cell}
                    onChange={(event) =>
                      updateCell(rowIndex, columnIndex, event.currentTarget.value)
                    }
                    className="h-10 w-full bg-transparent px-3 text-paragraph-sm outline-none focus:bg-bg-weak-50"
                    aria-label={`Cell ${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`}
                  />
                </Table.Cell>
              ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </section>
  );
}

/** Structure-aware slide editor over the canonical presentation state (title,
 * body, and speaker notes per slide). Round-trips through the same revisioned
 * workpiece state as every other surface; the native PPTX export is derived from
 * it. Slide visuals, layouts, and media are out of scope (see the fidelity note). */
export function SlidesSurface({
  slides,
  loading,
  onChange,
}: {
  readonly slides: readonly ArtifactPresentationSlide[];
  readonly loading: boolean;
  readonly onChange: (slides: ArtifactPresentationSlide[]) => void;
}) {
  const clone = () => slides.map((slide) => ({ ...slide }));
  const patch = (index: number, next: Partial<ArtifactPresentationSlide>) =>
    onChange(slides.map((slide, position) => (position === index ? { ...slide, ...next } : { ...slide })));
  const addSlide = () =>
    onChange([...clone(), { title: `Slide ${slides.length + 1}`, body: "", notes: "" }]);
  const removeSlide = (index: number) =>
    onChange(slides.filter((_, position) => position !== index).map((slide) => ({ ...slide })));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= slides.length) return;
    const next = clone();
    const moved = next[index];
    const displaced = next[target];
    if (!moved || !displaced) return;
    next[index] = displaced;
    next[target] = moved;
    onChange(next);
  };

  return (
    <section className="mt-6 flex min-h-0 flex-1 flex-col gap-4">
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
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-2">
        {slides.map((slide, index) => (
          <article
            key={index}
            className="rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-mono-label text-text-soft-400">Slide {index + 1}</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={loading || index === 0}
                  aria-label={`Move slide ${index + 1} up`}
                  title="Move up"
                  className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-30"
                >
                  <RiArrowUpLine aria-hidden className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={loading || index === slides.length - 1}
                  aria-label={`Move slide ${index + 1} down`}
                  title="Move down"
                  className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-30"
                >
                  <RiArrowDownLine aria-hidden className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => removeSlide(index)}
                  disabled={loading}
                  aria-label={`Delete slide ${index + 1}`}
                  title="Delete slide"
                  className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 hover:text-error-base disabled:opacity-30"
                >
                  <RiDeleteBinLine aria-hidden className="size-4" />
                </button>
              </div>
            </div>
            <label className="mt-3 block text-label-xs text-text-sub-600">
              Title
              <input
                value={slide.title}
                disabled={loading}
                onChange={(event) => patch(index, { title: event.currentTarget.value })}
                className="mt-1 h-9 w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 text-label-sm text-text-strong-950 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 disabled:opacity-50"
              />
            </label>
            <label className="mt-3 block text-label-xs text-text-sub-600">
              Body
              <textarea
                value={slide.body}
                disabled={loading}
                onChange={(event) => patch(index, { body: event.currentTarget.value })}
                className="mt-1 min-h-24 w-full resize-y rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-3 text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 disabled:opacity-50"
              />
            </label>
            <label className="mt-3 block text-label-xs text-text-sub-600">
              Speaker notes
              <textarea
                value={slide.notes ?? ""}
                disabled={loading}
                onChange={(event) => patch(index, { notes: event.currentTarget.value })}
                className="mt-1 min-h-16 w-full resize-y rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-3 text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 disabled:opacity-50"
              />
            </label>
          </article>
        ))}
        {slides.length === 0 && (
          <p className="rounded-xl border border-dashed border-stroke-soft-200 px-4 py-8 text-center text-paragraph-sm text-text-sub-600">
            No slides yet. Add the first slide to start the deck.
          </p>
        )}
      </div>
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
        <p className="mt-5 rounded-lg border border-warning-base bg-warning-lighter px-4 py-3 text-paragraph-sm text-warning-base">
          This sheet is larger than the browser grid limit, so it is open as CSV source.
        </p>
      )}
      <label htmlFor="workpiece-source" className="mt-6 text-label-sm text-text-strong-950">
        {label}
      </label>
      <textarea
        id="workpiece-source"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={loading}
        spellCheck={!spreadsheet}
        className="mt-2 min-h-[520px] w-full flex-1 resize-y rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-4 font-mono text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 disabled:opacity-50"
      />
    </>
  );
}
