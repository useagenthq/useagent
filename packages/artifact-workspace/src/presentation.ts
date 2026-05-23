// Pure presentation-deck logic shared by the backend control plane and the
// browser. ONE definition of the v2 deck model lives here: validation (a
// security boundary for agent- and user-supplied state), deterministic v1->v2
// migration (and the lossless-where-possible v2->v1 downgrade), theme presets,
// and small block helpers the renderer and editor reuse. No I/O, no DOM.

import {
  DECK_REFERENCE_HEIGHT,
  DECK_REFERENCE_WIDTH,
  PRESENTATION_SCHEMA_VERSION,
  type ArtifactPresentationSlide,
  type DeckBackground,
  type DeckBlock,
  type DeckBlockStyle,
  type DeckBlockType,
  type DeckSlide,
  type DeckTextAlign,
  type DeckTheme,
  type PresentationDeck,
} from "./contracts";

export const MAX_DECK_SLIDES = 200;
export const MAX_DECK_BLOCKS_PER_SLIDE = 60;
/** Per-string ceiling so one pathological block cannot bloat validation before
 * the overall MAX_WORKPIECE_STATE_BYTES check catches it. */
const MAX_DECK_TEXT_LENGTH = 40_000;

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const BLOCK_TYPES: readonly DeckBlockType[] = ["heading", "text", "image", "shape"];
const TEXT_ALIGNS: readonly DeckTextAlign[] = ["left", "center", "right"];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A text field is safe when it is a string with no control characters and
 * within the per-string length ceiling. */
function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_DECK_TEXT_LENGTH &&
    !CONTROL_CHARS.test(value);
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** An image/background URL is safe when it is a same-origin relative path or an
 * https URL (the app serves artifact assets from `/api/...`). Everything else
 * (javascript:, data:, http:) fails closed. */
function safeAssetUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (CONTROL_CHARS.test(value)) return false;
  return value.startsWith("/") || value.startsWith("https://");
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

// --- Theme presets ---------------------------------------------------------

export const DECK_THEME_PRESETS: readonly Readonly<{
  id: string;
  label: string;
  theme: DeckTheme;
}>[] = [
  {
    id: "midnight",
    label: "Midnight",
    theme: {
      background: { type: "gradient", from: "#141a2e", to: "#0a0d18", angle: 160 },
      heading: "#f4f6fd",
      body: "#aeb7d6",
      accent: "#7aa2f7",
    },
  },
  {
    id: "paper",
    label: "Paper",
    theme: {
      background: { type: "color", color: "#f6f5f1" },
      heading: "#1b1b1f",
      body: "#44454f",
      accent: "#d9633b",
    },
  },
  {
    id: "slate",
    label: "Slate",
    theme: {
      background: { type: "gradient", from: "#2a2f3a", to: "#171a21", angle: 165 },
      heading: "#f2f4f8",
      body: "#c2c8d4",
      accent: "#5ed0b3",
    },
  },
  {
    id: "sky",
    label: "Sky",
    theme: {
      background: { type: "gradient", from: "#1d5fd0", to: "#123a86", angle: 150 },
      heading: "#ffffff",
      body: "#d6e2ff",
      accent: "#ffd166",
    },
  },
];

export const DEFAULT_DECK_THEME: DeckTheme = DECK_THEME_PRESETS[0]!.theme;

// --- Validation / normalization (fails closed) -----------------------------

function normalizeBackground(value: unknown): DeckBackground | null {
  const item = record(value);
  if (!item) return null;
  if (item.type === "color") {
    return isHexColor(item.color) ? { type: "color", color: item.color } : null;
  }
  if (item.type === "gradient") {
    if (!isHexColor(item.from) || !isHexColor(item.to)) return null;
    const angle = clampNumber(item.angle, 0, 360, 160);
    return { type: "gradient", from: item.from, to: item.to, angle };
  }
  if (item.type === "image") {
    return safeAssetUrl(item.url) ? { type: "image", url: item.url } : null;
  }
  return null;
}

function normalizeStyle(value: unknown): DeckBlockStyle | undefined {
  const item = record(value);
  if (!item) return undefined;
  const style: {
    color?: string;
    fontSize?: number;
    bold?: boolean;
    italic?: boolean;
    align?: DeckTextAlign;
    fill?: string;
    radius?: number;
  } = {};
  if (isHexColor(item.color)) style.color = item.color;
  if (typeof item.fontSize === "number" && Number.isFinite(item.fontSize)) {
    style.fontSize = clampNumber(item.fontSize, 4, 400, 44);
  }
  if (item.bold === true) style.bold = true;
  if (item.italic === true) style.italic = true;
  if (typeof item.align === "string" && TEXT_ALIGNS.includes(item.align as DeckTextAlign)) {
    style.align = item.align as DeckTextAlign;
  }
  if (isHexColor(item.fill)) style.fill = item.fill;
  if (typeof item.radius === "number" && Number.isFinite(item.radius)) {
    style.radius = clampNumber(item.radius, 0, 400, 0);
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function normalizeBlock(value: unknown): DeckBlock | null {
  const item = record(value);
  if (!item) return null;
  const type = item.type;
  if (typeof type !== "string" || !BLOCK_TYPES.includes(type as DeckBlockType)) return null;
  if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 128) return null;
  // Content: heading/text carry text; image carries a safe asset URL; shape may
  // be empty. Fail closed on anything unsafe.
  let content = "";
  if (type === "image") {
    if (!safeAssetUrl(item.content)) return null;
    content = item.content;
  } else if (type === "shape") {
    content = safeText(item.content) ? item.content : "";
  } else {
    if (!safeText(item.content)) return null;
    content = item.content;
  }
  const style = normalizeStyle(item.style);
  return {
    id: item.id,
    type: type as DeckBlockType,
    x: clampNumber(item.x, -20, 120, 0),
    y: clampNumber(item.y, -20, 120, 0),
    w: clampNumber(item.w, 1, 140, 100),
    h: clampNumber(item.h, 1, 140, 20),
    content,
    ...(style ? { style } : {}),
  };
}

function normalizeSlide(value: unknown): DeckSlide | null {
  const item = record(value);
  if (!item) return null;
  if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 128) return null;
  if (!Array.isArray(item.blocks) || item.blocks.length > MAX_DECK_BLOCKS_PER_SLIDE) return null;
  const blocks: DeckBlock[] = [];
  for (const raw of item.blocks) {
    const block = normalizeBlock(raw);
    if (!block) return null;
    blocks.push(block);
  }
  let background: DeckBackground | undefined;
  if (item.background !== undefined && item.background !== null) {
    const parsed = normalizeBackground(item.background);
    if (!parsed) return null;
    background = parsed;
  }
  let notes: string | undefined;
  if (item.notes !== undefined && item.notes !== null) {
    if (!safeText(item.notes)) return null;
    if (item.notes.length > 0) notes = item.notes;
  }
  return {
    id: item.id,
    blocks,
    ...(background ? { background } : {}),
    ...(notes ? { notes } : {}),
  };
}

function normalizeTheme(value: unknown): DeckTheme | null {
  const item = record(value);
  if (!item) return null;
  const background = normalizeBackground(item.background);
  if (!background || !isHexColor(item.heading) || !isHexColor(item.body) || !isHexColor(item.accent)) {
    return null;
  }
  return { background, heading: item.heading, body: item.body, accent: item.accent };
}

/** Validate and normalize an unknown value into a canonical v2 deck, or null.
 * Fails closed: bad structure, unsafe text/colors/URLs, or over-cap sizes all
 * yield null. Numeric position/size fields are clamped, not rejected. */
export function normalizeDeck(value: unknown): PresentationDeck | null {
  const item = record(value);
  if (!item) return null;
  if (item.schemaVersion !== PRESENTATION_SCHEMA_VERSION) return null;
  const theme = normalizeTheme(item.theme);
  if (!theme) return null;
  if (!Array.isArray(item.slides) || item.slides.length > MAX_DECK_SLIDES) return null;
  const slides: DeckSlide[] = [];
  for (const raw of item.slides) {
    const slide = normalizeSlide(raw);
    if (!slide) return null;
    slides.push(slide);
  }
  return { schemaVersion: PRESENTATION_SCHEMA_VERSION, theme, slides };
}

// --- Deterministic migration (v1 <-> v2) -----------------------------------

/** Migrated-slide block layout, in reference percent. Deterministic so
 * migration is pure and round-trips through `deckToSlides` losslessly. */
const MIGRATE_HEADING = { x: 6, y: 8, w: 88, h: 17 } as const;
const MIGRATE_TEXT = { x: 6, y: 30, w: 88, h: 62 } as const;
const MIGRATE_HEADING_FONT = 96;
const MIGRATE_TEXT_FONT = 44;

function migratedSlide(slide: ArtifactPresentationSlide, index: number): DeckSlide {
  const id = `slide-${index + 1}`;
  const blocks: DeckBlock[] = [
    {
      id: `${id}-heading`,
      type: "heading",
      ...MIGRATE_HEADING,
      content: slide.title,
      style: { fontSize: MIGRATE_HEADING_FONT, bold: true, align: "left" },
    },
    {
      id: `${id}-body`,
      type: "text",
      ...MIGRATE_TEXT,
      content: slide.body,
      style: { fontSize: MIGRATE_TEXT_FONT, align: "left" },
    },
  ];
  return {
    id,
    blocks,
    ...(slide.notes ? { notes: slide.notes } : {}),
  };
}

/** Deterministically upgrade v1 title/body slides into a v2 deck. Pure: the same
 * slides + theme always produce the same deck (index-based ids, fixed layout). */
export function migrateSlidesToDeck(
  slides: readonly ArtifactPresentationSlide[],
  theme: DeckTheme = DEFAULT_DECK_THEME,
): PresentationDeck {
  return {
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    theme,
    slides: slides.map(migratedSlide),
  };
}

/** The first heading block on a slide (the "primary" title block). */
export function primaryHeadingBlock(slide: DeckSlide): DeckBlock | null {
  return slide.blocks.find((block) => block.type === "heading") ?? null;
}

/** The first text block on a slide (the "primary" body block). */
export function primaryBodyBlock(slide: DeckSlide): DeckBlock | null {
  return slide.blocks.find((block) => block.type === "text") ?? null;
}

/** Downgrade a deck to v1 title/body slides. Lossless for decks that carry a
 * single heading + single text block per slide (what migration produces); other
 * blocks (image/shape, extra text) are dropped, which is the documented lossy
 * edge of the Office export path. */
export function deckToSlides(deck: PresentationDeck): ArtifactPresentationSlide[] {
  return deck.slides.map((slide) => {
    const heading = primaryHeadingBlock(slide);
    const body = primaryBodyBlock(slide);
    return {
      title: heading?.content ?? "",
      body: body?.content ?? "",
      ...(slide.notes ? { notes: slide.notes } : {}),
    };
  });
}

// --- v1 slide parsing + coercion into canonical state ----------------------

function parseV1Slide(value: unknown): ArtifactPresentationSlide | null {
  const item = record(value);
  if (!item) return null;
  if (!safeText(item.title) || !safeText(item.body)) return null;
  if (item.notes !== undefined && !safeText(item.notes)) return null;
  return {
    title: item.title,
    body: item.body,
    ...(typeof item.notes === "string" ? { notes: item.notes } : {}),
  };
}

function parseV1Slides(value: unknown): ArtifactPresentationSlide[] | null {
  if (!Array.isArray(value) || value.length > MAX_DECK_SLIDES) return null;
  const slides: ArtifactPresentationSlide[] = [];
  for (const raw of value) {
    const slide = parseV1Slide(raw);
    if (!slide) return null;
    slides.push(slide);
  }
  return slides;
}

/** True when a `{ slides }` value carries v2 block-slides (not v1 title/body) -
 * i.e. it is a bare deck missing its `deck` wrapper. */
function looksLikeBareDeck(value: Record<string, unknown>): boolean {
  if (value.schemaVersion === PRESENTATION_SCHEMA_VERSION || record(value.theme)) return true;
  const first = Array.isArray(value.slides) ? value.slides[0] : undefined;
  return !!record(first) && Array.isArray((first as Record<string, unknown>).blocks);
}

/** Coerce any accepted presentation input into a canonical v2 deck:
 *  - `{ deck }`            -> validate the deck
 *  - a bare deck object    -> validate it directly
 *  - `{ slides: v1[] }`    -> migrate v1 title/body slides
 *  - a bare v1 slide array -> migrate
 * Returns null on anything invalid. This is the single upgrade-on-load path both
 * the backend (write + read boundaries) and the browser funnel through. */
export function coerceDeck(value: unknown): PresentationDeck | null {
  if (Array.isArray(value)) {
    const slides = parseV1Slides(value);
    return slides ? migrateSlidesToDeck(slides) : null;
  }
  const item = record(value);
  if (!item) return null;
  if ("deck" in item) return normalizeDeck(item.deck);
  if (item.schemaVersion === PRESENTATION_SCHEMA_VERSION) return normalizeDeck(item);
  if ("slides" in item) {
    if (looksLikeBareDeck(item)) return normalizeDeck(item);
    const slides = parseV1Slides(item.slides);
    return slides ? migrateSlidesToDeck(slides) : null;
  }
  return null;
}

/** Coerce into the canonical `{ deck }` state, or null. */
export function coercePresentationState(
  value: unknown,
): Readonly<{ deck: PresentationDeck }> | null {
  const deck = coerceDeck(value);
  return deck ? { deck } : null;
}

// --- Editor helpers (block factory + quick-edit mapping) --------------------

const BLOCK_PRESET: Record<DeckBlockType, Omit<DeckBlock, "id">> = {
  heading: {
    type: "heading",
    x: 8,
    y: 10,
    w: 84,
    h: 16,
    content: "Heading",
    style: { fontSize: 84, bold: true, align: "left" },
  },
  text: {
    type: "text",
    x: 8,
    y: 32,
    w: 84,
    h: 40,
    content: "Body text",
    style: { fontSize: 40, align: "left" },
  },
  image: { type: "image", x: 30, y: 28, w: 40, h: 44, content: "" },
  shape: { type: "shape", x: 8, y: 78, w: 30, h: 8, content: "", style: { radius: 12 } },
};

/** A fresh block of a given type with the supplied id (id generation is the
 * caller's concern so pure migration stays deterministic). */
export function deckBlockPreset(type: DeckBlockType, id: string): DeckBlock {
  return { id, ...BLOCK_PRESET[type] };
}

/** A fresh slide carrying a heading + body preset, matching migration output. */
export function emptyDeckSlide(id: string, title = "New slide"): DeckSlide {
  return {
    id,
    blocks: [
      {
        id: `${id}-heading`,
        type: "heading",
        ...MIGRATE_HEADING,
        content: title,
        style: { fontSize: MIGRATE_HEADING_FONT, bold: true, align: "left" },
      },
      {
        id: `${id}-body`,
        type: "text",
        ...MIGRATE_TEXT,
        content: "",
        style: { fontSize: MIGRATE_TEXT_FONT, align: "left" },
      },
    ],
  };
}

/** The effective background for a slide: its override, else the deck theme. */
export function resolveSlideBackground(deck: PresentationDeck, slide: DeckSlide): DeckBackground {
  return slide.background ?? deck.theme.background;
}

/** The effective text color for a block: its style override, else the theme
 * role (heading blocks use theme.heading, everything else theme.body). */
export function resolveBlockColor(block: DeckBlock, theme: DeckTheme): string {
  return block.style?.color ?? (block.type === "heading" ? theme.heading : theme.body);
}

export { DECK_REFERENCE_HEIGHT, DECK_REFERENCE_WIDTH, PRESENTATION_SCHEMA_VERSION };
