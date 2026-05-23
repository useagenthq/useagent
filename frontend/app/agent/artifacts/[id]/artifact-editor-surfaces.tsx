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
  RiImageLine,
  RiItalic,
  RiLink,
  RiListOrdered,
  RiListUnordered,
  RiShapesLine,
  RiText,
  RiUnderline,
} from "@remixicon/react";
import type { ArtifactWorkpieceKind } from "@skynet/agent-client";
import {
  artifactFidelityFor,
  DECK_THEME_PRESETS,
  deckBlockPreset,
  primaryBodyBlock,
  primaryHeadingBlock,
  type DeckBackground,
  type DeckBlock,
  type DeckBlockStyle,
  type DeckBlockType,
  type DeckSlide,
  type DeckTheme,
  type DocumentTheme,
  type PresentationDeck,
} from "@skynet/artifact-workspace";
import { type CSSProperties, type RefObject, useId, useState } from "react";
import type { WorkpieceEditorController } from "./artifact-editor-state";
import { sanitizeRichHtml } from "./artifact-editor-model";
import { DeckSlideCanvas } from "./deck-canvas";
import { SheetGridSurface } from "./sheet-grid";

export { SheetGridSurface } from "./sheet-grid";

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

/** The CSS background for a document theme background: a solid color, a linear
 * gradient, or a cover image (mirrors the deck-canvas resolution). */
function documentBackgroundStyle(background: DeckBackground): CSSProperties {
  if (background.type === "gradient") {
    return {
      background: `linear-gradient(${background.angle ?? 160}deg, ${background.from}, ${background.to})`,
    };
  }
  if (background.type === "image") {
    return { backgroundImage: `url("${background.url}")`, backgroundSize: "cover", backgroundPosition: "center" };
  }
  return { background: background.color };
}

export function RichDocumentSurface({
  editorRef,
  loading,
  onChange,
  theme,
  onThemeChange,
}: {
  readonly editorRef: RefObject<HTMLDivElement | null>;
  readonly loading: boolean;
  readonly onChange: (html: string) => void;
  /** The document theme applied to the rendered/edited surface (background +
   * heading/body colors); its picker reuses the deck preset pattern. */
  readonly theme: DocumentTheme;
  readonly onThemeChange: (theme: DocumentTheme) => void;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("https://");
  // A stable class scopes the heading-color rule to THIS editor so two mounted
  // rich documents never bleed themes into each other.
  const themeClass = `doc-theme-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id="workpiece-rich-label" className="text-label-sm text-text-strong-950">
          Rich document
        </p>
        <details className="group">
          <summary className="cursor-pointer list-none rounded-lg border border-stroke-soft-200 px-2.5 py-1 text-label-xs text-text-sub-600 outline-none hover:bg-bg-weak-50 hover:text-text-strong-950">
            Theme
          </summary>
          <div className="absolute right-3 z-10 mt-1 w-72 max-w-[calc(100%-1.5rem)] rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-1 shadow-regular-md">
            <ThemeControls
              theme={theme}
              onChange={(next) => onThemeChange(next)}
              label="Document theme"
            />
          </div>
        </details>
      </div>
      {/* Scoped heading color so the theme's heading role paints h1-h3 in the
          contentEditable without touching any other editor on the page. */}
      <style>{`.${themeClass} h1,.${themeClass} h2,.${themeClass} h3{color:${theme.heading}}`}</style>
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
        // The theme paints the rendered/edited surface: page background + body
        // text color inline, heading color through the scoped rule above.
        style={{ ...documentBackgroundStyle(theme.background), color: theme.body }}
        className={`${themeClass} prose prose-sm mt-4 min-h-[420px] w-full flex-1 overflow-auto rounded-xl border border-stroke-soft-200 p-6 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 aria-disabled:opacity-50`}
      />
    </>
  );
}

function rid(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Math.random()}`).replace(/-/g, "").slice(0, 8);
}

/** A raw color to the 6-digit `#rrggbb` an `<input type="color">` requires. */
function toColorInput(hex: string): string {
  const raw = hex.replace(/^#/, "");
  const six = raw.length === 3
    ? [...raw].map((c) => c + c).join("")
    : raw.length >= 6
    ? raw.slice(0, 6)
    : "000000";
  return `#${six}`;
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-label-xs text-text-sub-600">
      {label}
      <input
        type="number"
        value={Math.round(value * 10) / 10}
        min={min}
        max={max}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className="h-8 w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-2 text-label-sm text-text-strong-950 outline-none focus:border-stroke-strong-950"
      />
    </label>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-label-xs text-text-sub-600">
      <span>{label}</span>
      <input
        type="color"
        aria-label={label}
        value={toColorInput(value)}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-7 w-10 cursor-pointer rounded border border-stroke-soft-200 bg-bg-white-0"
      />
    </label>
  );
}

const BLOCK_ADD: readonly (readonly [DeckBlockType, string, typeof RiText])[] = [
  ["heading", "Heading", RiH1],
  ["text", "Text", RiText],
  ["image", "Image", RiImageLine],
  ["shape", "Shape", RiShapesLine],
];

/** Inspector for the one selected block: content, position/size, and per-type
 * style (text color/size/weight/align, shape fill/radius, image URL). */
function BlockInspector({
  block,
  onChange,
  onRemove,
}: {
  readonly block: DeckBlock;
  readonly onChange: (next: DeckBlock) => void;
  readonly onRemove: () => void;
}) {
  const setStyle = (patch: Partial<DeckBlockStyle>) => {
    const style: Record<string, unknown> = { ...block.style };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === false || value === "") delete style[key];
      else style[key] = value;
    }
    onChange({ ...block, style: Object.keys(style).length ? (style as DeckBlockStyle) : undefined });
  };
  const isText = block.type === "heading" || block.type === "text";

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-3">
      <div className="flex items-center justify-between">
        <p className="text-label-sm text-text-strong-950">
          {block.type[0]?.toUpperCase()}
          {block.type.slice(1)} block
        </p>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove block"
          title="Remove block"
          className="grid size-7 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-white-0 hover:text-error-base"
        >
          <RiDeleteBinLine aria-hidden className="size-4" />
        </button>
      </div>

      {isText && (
        <textarea
          value={block.content}
          onChange={(event) => onChange({ ...block, content: event.currentTarget.value })}
          aria-label="Block text"
          className="min-h-16 w-full resize-y rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-2 text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950"
        />
      )}
      {block.type === "image" && (
        <input
          value={block.content}
          onChange={(event) => onChange({ ...block, content: event.currentTarget.value })}
          placeholder="/api/... or https://"
          aria-label="Image URL"
          className="h-8 w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-2 text-label-sm text-text-strong-950 outline-none focus:border-stroke-strong-950"
        />
      )}

      <div className="grid grid-cols-4 gap-2">
        <NumberField label="X %" value={block.x} onChange={(x) => onChange({ ...block, x })} />
        <NumberField label="Y %" value={block.y} onChange={(y) => onChange({ ...block, y })} />
        <NumberField label="W %" value={block.w} onChange={(w) => onChange({ ...block, w })} min={1} />
        <NumberField label="H %" value={block.h} onChange={(h) => onChange({ ...block, h })} min={1} />
      </div>

      {isText && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Font px"
              value={block.style?.fontSize ?? (block.type === "heading" ? 96 : 44)}
              onChange={(fontSize) => setStyle({ fontSize })}
              min={4}
            />
            <label className="flex flex-col gap-1 text-label-xs text-text-sub-600">
              Align
              <select
                value={block.style?.align ?? "left"}
                onChange={(event) => setStyle({ align: event.currentTarget.value as DeckBlockStyle["align"] })}
                className="h-8 w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-2 text-label-sm text-text-strong-950 outline-none focus:border-stroke-strong-950"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-pressed={block.style?.bold ?? false}
              onClick={() => setStyle({ bold: !(block.style?.bold ?? false) })}
              className="grid size-8 place-items-center rounded-lg border border-stroke-soft-200 text-text-sub-600 hover:bg-bg-white-0 aria-pressed:bg-bg-strong-950 aria-pressed:text-text-white-0"
            >
              <RiBold aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              aria-pressed={block.style?.italic ?? false}
              onClick={() => setStyle({ italic: !(block.style?.italic ?? false) })}
              className="grid size-8 place-items-center rounded-lg border border-stroke-soft-200 text-text-sub-600 hover:bg-bg-white-0 aria-pressed:bg-bg-strong-950 aria-pressed:text-text-white-0"
            >
              <RiItalic aria-hidden className="size-4" />
            </button>
            <ColorField
              label="Color"
              value={block.style?.color ?? "#ffffff"}
              onChange={(color) => setStyle({ color })}
            />
          </div>
        </div>
      )}
      {block.type === "shape" && (
        <div className="grid grid-cols-2 gap-2">
          <ColorField
            label="Fill"
            value={block.style?.fill ?? "#7aa2f7"}
            onChange={(fill) => setStyle({ fill })}
          />
          <NumberField
            label="Radius"
            value={block.style?.radius ?? 0}
            onChange={(radius) => setStyle({ radius })}
            min={0}
          />
        </div>
      )}
    </div>
  );
}

/** Theme picker shared by the deck and the themed document: tasteful presets plus
 * custom heading/body/accent and a solid background color. Theme colors are
 * document data (raw hex is allowed). */
function ThemeControls({
  theme,
  onChange,
  label = "Deck theme",
}: {
  readonly theme: DeckTheme;
  readonly onChange: (theme: DeckTheme) => void;
  readonly label?: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-stroke-soft-200 p-3">
      <p className="text-label-sm text-text-strong-950">{label}</p>
      <div className="flex flex-wrap gap-2">
        {DECK_THEME_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onChange(preset.theme)}
            title={preset.label}
            aria-label={`${preset.label} theme`}
            className="size-8 rounded-lg border border-stroke-soft-200"
            style={preset.theme.background.type === "gradient"
              ? {
                background:
                  `linear-gradient(150deg, ${preset.theme.background.from}, ${preset.theme.background.to})`,
              }
              : preset.theme.background.type === "color"
              ? { background: preset.theme.background.color }
              : { background: preset.theme.accent }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <ColorField
          label="Background"
          value={theme.background.type === "color"
            ? theme.background.color
            : theme.background.type === "gradient"
            ? theme.background.from
            : theme.accent}
          onChange={(color) => onChange({ ...theme, background: { type: "color", color } })}
        />
        <ColorField label="Accent" value={theme.accent} onChange={(accent) => onChange({ ...theme, accent })} />
        <ColorField label="Heading" value={theme.heading} onChange={(heading) => onChange({ ...theme, heading })} />
        <ColorField label="Body" value={theme.body} onChange={(body) => onChange({ ...theme, body })} />
      </div>
    </div>
  );
}

/** Web-native deck editor over the canonical v2 presentation state. Renders the
 * deck with the SAME DeckSlideCanvas used by the filmstrip (one renderer, two
 * scales), with per-block select/drag/edit, add/remove block, a deck theme
 * picker, per-slide background, and a title/body quick-edit that writes the
 * slide's primary heading and text blocks. The themed PPTX export is derived
 * from this exact state. */
export function DeckSurface({
  deck,
  loading,
  onChange,
}: {
  readonly deck: PresentationDeck | null;
  readonly loading: boolean;
  readonly onChange: (deck: PresentationDeck) => void;
}) {
  const [index, setIndex] = useState(0);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  if (!deck) {
    return (
      <p className="mt-4 rounded-xl border border-dashed border-stroke-soft-200 px-4 py-8 text-center text-paragraph-sm text-text-sub-600">
        Loading deck...
      </p>
    );
  }

  const slides = deck.slides;
  const activeIndex = Math.min(index, Math.max(0, slides.length - 1));
  const slide: DeckSlide | undefined = slides[activeIndex];
  const selected = slide?.blocks.find((block) => block.id === selectedBlockId) ?? null;

  const setSlides = (next: readonly DeckSlide[]) => onChange({ ...deck, slides: next });
  const mapActive = (fn: (slide: DeckSlide) => DeckSlide) =>
    setSlides(slides.map((item, position) => (position === activeIndex ? fn(item) : item)));
  const patchBlock = (next: DeckBlock) =>
    mapActive((item) => ({
      ...item,
      blocks: item.blocks.map((block) => (block.id === next.id ? next : block)),
    }));

  const addSlide = () => {
    const id = `slide-${rid()}`;
    onChange({
      ...deck,
      slides: [
        ...slides,
        {
          id,
          blocks: [
            {
              id: `${id}-heading`,
              type: "heading",
              x: 6,
              y: 8,
              w: 88,
              h: 17,
              content: `Slide ${slides.length + 1}`,
              style: { fontSize: 96, bold: true, align: "left" },
            },
            { id: `${id}-body`, type: "text", x: 6, y: 30, w: 88, h: 62, content: "", style: { fontSize: 44 } },
          ],
        },
      ],
    });
    setIndex(slides.length);
    setSelectedBlockId(null);
  };
  const removeSlide = () => {
    setSlides(slides.filter((_, position) => position !== activeIndex));
    setIndex((current) => Math.max(0, current > activeIndex ? current - 1 : current));
    setSelectedBlockId(null);
  };
  const moveSlide = (delta: number) => {
    const target = activeIndex + delta;
    if (target < 0 || target >= slides.length) return;
    const next = [...slides];
    const moved = next[activeIndex]!;
    next[activeIndex] = next[target]!;
    next[target] = moved;
    setSlides(next);
    setIndex(target);
  };
  const addBlock = (type: DeckBlockType) => {
    const block = deckBlockPreset(type, `${type}-${rid()}`);
    mapActive((item) => ({ ...item, blocks: [...item.blocks, block] }));
    setSelectedBlockId(block.id);
  };
  const removeBlock = (id: string) => {
    mapActive((item) => ({ ...item, blocks: item.blocks.filter((block) => block.id !== id) }));
    setSelectedBlockId(null);
  };
  const setSlideBackground = (background: DeckBackground | null) =>
    mapActive((item) => {
      if (!background) {
        const { background: _drop, ...rest } = item;
        return rest;
      }
      return { ...item, background };
    });
  const setNotes = (notes: string) =>
    mapActive((item) => {
      if (!notes) {
        const { notes: _drop, ...rest } = item;
        return rest;
      }
      return { ...item, notes };
    });
  // Quick-edit writes the slide's primary heading/text block, creating one if the
  // slide has none, so the convenience fields always map to real blocks.
  const setPrimary = (type: "heading" | "text", content: string) =>
    mapActive((item) => {
      const existing = (type === "heading" ? primaryHeadingBlock(item) : primaryBodyBlock(item));
      if (existing) {
        return {
          ...item,
          blocks: item.blocks.map((block) => (block.id === existing.id ? { ...block, content } : block)),
        };
      }
      return { ...item, blocks: [...item.blocks, { ...deckBlockPreset(type, `${type}-${rid()}`), content }] };
    });

  const headingText = slide ? primaryHeadingBlock(slide)?.content ?? "" : "";
  const bodyText = slide ? primaryBodyBlock(slide)?.content ?? "" : "";

  return (
    <section className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-label-sm text-text-strong-950">Slides ({slides.length})</p>
        <button
          type="button"
          onClick={addSlide}
          disabled={loading}
          className="inline-flex h-8 items-center gap-2 rounded-lg border border-stroke-soft-200 px-3 text-label-sm hover:bg-bg-weak-50 disabled:opacity-50"
        >
          <RiAddLine aria-hidden className="size-4" /> Add slide
        </button>
      </div>

      {slides.length === 0 || !slide ? (
        <p className="rounded-xl border border-dashed border-stroke-soft-200 px-4 py-8 text-center text-paragraph-sm text-text-sub-600">
          No slides yet. Add the first slide to start the deck.
        </p>
      ) : (
        <>
          <DeckSlideCanvas
            deck={deck}
            slide={slide}
            editing={!loading}
            selectedBlockId={selectedBlockId}
            onSelectBlock={setSelectedBlockId}
            onMoveBlock={(id, x, y) => {
              const target = slide.blocks.find((block) => block.id === id);
              if (target) patchBlock({ ...target, x, y });
            }}
            className="w-full rounded-xl border border-stroke-soft-200 shadow-regular-xs"
          />

          {/* Slide navigation + reorder + delete. */}
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
                onClick={() => moveSlide(-1)}
                disabled={loading || activeIndex === 0}
                aria-label={`Move slide ${activeIndex + 1} earlier`}
                title="Move earlier"
                className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-30"
              >
                <RiArrowUpLine aria-hidden className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => moveSlide(1)}
                disabled={loading || activeIndex === slides.length - 1}
                aria-label={`Move slide ${activeIndex + 1} later`}
                title="Move later"
                className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-30"
              >
                <RiArrowDownLine aria-hidden className="size-4" />
              </button>
              <button
                type="button"
                onClick={removeSlide}
                disabled={loading}
                aria-label={`Delete slide ${activeIndex + 1}`}
                title="Delete slide"
                className="grid size-8 place-items-center rounded-lg text-text-sub-600 hover:bg-bg-weak-50 hover:text-error-base disabled:opacity-30"
              >
                <RiDeleteBinLine aria-hidden className="size-4" />
              </button>
            </div>
          </div>

          {/* Filmstrip: the SAME renderer at thumbnail scale, editing off. The
              explicit height + shrink-0 keep this horizontal scroll row (an
              overflow container nested in a flex column) from collapsing. */}
          {slides.length > 1 && (
            <div className="flex h-[71px] shrink-0 items-center gap-2 overflow-x-auto pb-1">
              {slides.map((item, position) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setIndex(position);
                    setSelectedBlockId(null);
                  }}
                  aria-current={position === activeIndex}
                  title={`Slide ${position + 1}`}
                  // Explicit 16:9 height (w-28 = 112px -> 63px) so the flex-item
                  // button does not collapse around its padding-sized canvas.
                  className={
                    position === activeIndex
                      ? "h-[63px] w-28 shrink-0 overflow-hidden rounded-lg border-2 border-primary-base"
                      : "h-[63px] w-28 shrink-0 overflow-hidden rounded-lg border border-stroke-soft-200 hover:border-stroke-sub-300"
                  }
                >
                  <DeckSlideCanvas deck={deck} slide={item} />
                </button>
              ))}
            </div>
          )}

          {/* Add block. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label-xs text-text-sub-600">Add block:</span>
            {BLOCK_ADD.map(([type, label, Icon]) => (
              <button
                key={type}
                type="button"
                onClick={() => addBlock(type)}
                disabled={loading}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-2.5 text-label-xs hover:bg-bg-weak-50 disabled:opacity-50"
              >
                <Icon aria-hidden className="size-4" /> {label}
              </button>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {/* Quick edit + slide-level controls. */}
            <div className="flex flex-col gap-3">
              <label className="block text-label-xs text-text-sub-600">
                Title
                <input
                  value={headingText}
                  disabled={loading}
                  onChange={(event) => setPrimary("heading", event.currentTarget.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 text-label-sm text-text-strong-950 outline-none focus:border-stroke-strong-950"
                />
              </label>
              <label className="block text-label-xs text-text-sub-600">
                Body
                <textarea
                  value={bodyText}
                  disabled={loading}
                  onChange={(event) => setPrimary("text", event.currentTarget.value)}
                  className="mt-1 min-h-20 w-full resize-y rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-3 text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950"
                />
              </label>
              <label className="block text-label-xs text-text-sub-600">
                Speaker notes
                <textarea
                  value={slide.notes ?? ""}
                  disabled={loading}
                  onChange={(event) => setNotes(event.currentTarget.value)}
                  className="mt-1 min-h-16 w-full resize-y rounded-lg border border-stroke-soft-200 bg-bg-white-0 p-3 text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950"
                />
              </label>
              <div className="flex items-center justify-between rounded-xl border border-stroke-soft-200 p-3 text-label-xs text-text-sub-600">
                <span>Slide background</span>
                {slide.background ? (
                  <div className="flex items-center gap-2">
                    <ColorField
                      label="Color"
                      value={slide.background.type === "color" ? slide.background.color : deck.theme.accent}
                      onChange={(color) => setSlideBackground({ type: "color", color })}
                    />
                    <button
                      type="button"
                      onClick={() => setSlideBackground(null)}
                      className="rounded-lg border border-stroke-soft-200 px-2 py-1 text-label-xs hover:bg-bg-weak-50"
                    >
                      Use theme
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSlideBackground({ type: "color", color: "#111827" })}
                    className="rounded-lg border border-stroke-soft-200 px-2 py-1 text-label-xs hover:bg-bg-weak-50"
                  >
                    Override
                  </button>
                )}
              </div>
            </div>

            {/* Theme + selected block inspector. */}
            <div className="flex flex-col gap-3">
              <ThemeControls theme={deck.theme} onChange={(theme) => onChange({ ...deck, theme })} />
              {selected ? (
                <BlockInspector
                  block={selected}
                  onChange={patchBlock}
                  onRemove={() => removeBlock(selected.id)}
                />
              ) : (
                <p className="rounded-xl border border-dashed border-stroke-soft-200 px-3 py-6 text-center text-paragraph-xs text-text-soft-400">
                  Select a block on the canvas to edit its content, position, and style.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export function SourceSurface({
  label,
  loading,
  value,
  onChange,
}: {
  readonly label: string;
  readonly loading: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <>
      <label htmlFor="workpiece-source" className="text-label-sm text-text-strong-950">
        {label}
      </label>
      <textarea
        id="workpiece-source"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={loading}
        className="mt-2 min-h-[420px] w-full flex-1 resize-y rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-4 font-mono text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950 focus:ring-2 focus:ring-stroke-soft-200 disabled:opacity-50"
      />
    </>
  );
}

/** The default honest note for a byte-authoritative (published) PDF embed. */
const PUBLISHED_PDF_NOTE =
  "Published PDF. Page reorder and delete are the supported revisions; the text and visual content are not editable here.";

/** Render PDF bytes as an inline embedded preview, never as raw text. Reused for
 * both a byte-authoritative (published) PDF workpiece and the rendered-PDF preview
 * of an Office binary; the note explains which surface is showing. */
export function PdfEmbedSurface({
  url,
  note = PUBLISHED_PDF_NOTE,
}: {
  readonly url: string;
  readonly note?: string;
}) {
  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col gap-2">
      <object
        data={url}
        type="application/pdf"
        aria-label="Embedded PDF preview"
        className="min-h-[420px] w-full flex-1 rounded-xl border border-stroke-soft-200 bg-bg-weak-50"
      >
        <div className="grid h-full place-items-center p-6 text-center text-paragraph-sm text-text-sub-600">
          <p>
            This PDF cannot preview inline here.{" "}
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-primary-base underline underline-offset-2"
            >
              Open the PDF
            </a>
          </p>
        </div>
      </object>
      <p className="text-paragraph-xs text-text-soft-400">{note}</p>
    </div>
  );
}

function formatKb(sizeBytes: number): string {
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/** The Code view for a byte-authoritative PDF: an honest one-line summary of the
 * binary source, never the raw %PDF bytes. */
export function PdfBinaryCodeView({ sizeBytes }: { readonly sizeBytes: number }) {
  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col">
      <p className="text-label-sm text-text-strong-950">PDF source</p>
      <p className="mt-1 text-paragraph-xs text-text-soft-400">
        Read-only. A published PDF stores immutable bytes, not editable text.
      </p>
      <pre className="mt-2 min-h-0 flex-1 overflow-auto rounded-xl border border-stroke-soft-200 bg-bg-weak-50 p-4 font-mono text-paragraph-xs text-text-strong-950">
        Binary PDF source ({formatKb(sizeBytes)}) - not text
      </pre>
    </div>
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
  if (editor.pdfEmbed) {
    return viewMode === "code" ? (
      <PdfBinaryCodeView sizeBytes={editor.sizeBytes} />
    ) : (
      <PdfEmbedSurface url={editor.pdfPreviewUrl} />
    );
  }
  if (viewMode === "code") {
    return <WorkpieceCodeView label={editor.label} source={editor.canonicalSource()} />;
  }
  if (editor.isRich) {
    return (
      <RichDocumentSurface
        editorRef={editor.richEditorRef}
        loading={editor.loading}
        onChange={editor.onRichChange}
        theme={editor.documentTheme}
        onThemeChange={editor.setDocumentTheme}
      />
    );
  }
  if (editor.isSheetGrid) {
    return (
      <SheetGridSurface workbook={editor.workbook} loading={editor.loading} onChange={editor.setWorkbook} />
    );
  }
  if (editor.isSlidesEditor) {
    return <DeckSurface deck={editor.deck} loading={editor.loading} onChange={editor.setDeck} />;
  }
  return (
    <SourceSurface
      label={editor.label}
      loading={editor.loading}
      value={editor.value}
      onChange={editor.setSource}
    />
  );
}
