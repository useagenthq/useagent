"use client";

// The ONE deck renderer. It draws a single slide as absolutely-positioned DOM on
// a 16:9 surface: blocks are placed by percent of the 1920x1080 reference and
// font sizes use container-query height units, so the SAME component renders at
// any scale (the full editor canvas and the filmstrip thumbnail alike). Deck
// theme colors are DOCUMENT data, so they are applied as raw inline styles (the
// brand-mark exception); the surrounding chrome uses semantic tokens.

import {
  DECK_REFERENCE_HEIGHT,
  resolveBlockColor,
  resolveSlideBackground,
  type DeckBackground,
  type DeckBlock,
  type DeckSlide,
  type PresentationDeck,
} from "@skynet/artifact-workspace";
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useRef } from "react";

/** A reference-px length as container-query-height units (1080px ref = 100cqh). */
function cqh(px: number): string {
  return `${px / (DECK_REFERENCE_HEIGHT / 100)}cqh`;
}

export function deckBackgroundStyle(background: DeckBackground): CSSProperties {
  if (background.type === "color") return { background: background.color };
  if (background.type === "gradient") {
    return {
      background: `linear-gradient(${background.angle ?? 160}deg, ${background.from}, ${background.to})`,
    };
  }
  return {
    backgroundImage: `url("${background.url}")`,
    backgroundSize: "cover",
    backgroundPosition: "center",
  };
}

function blockStyle(block: DeckBlock, deck: PresentationDeck): CSSProperties {
  const base: CSSProperties = {
    position: "absolute",
    left: `${block.x}%`,
    top: `${block.y}%`,
    width: `${block.w}%`,
    height: `${block.h}%`,
    overflow: "hidden",
  };
  if (block.type === "shape") {
    return {
      ...base,
      background: block.style?.fill ?? deck.theme.accent,
      borderRadius: cqh(block.style?.radius ?? 0),
    };
  }
  if (block.type === "image") return base;
  return {
    ...base,
    color: resolveBlockColor(block, deck.theme),
    fontSize: cqh(block.style?.fontSize ?? (block.type === "heading" ? 96 : 44)),
    fontWeight: (block.style?.bold ?? block.type === "heading") ? 700 : 400,
    fontStyle: block.style?.italic ? "italic" : "normal",
    textAlign: block.style?.align ?? "left",
    lineHeight: 1.15,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };
}

function BlockContent({ block, deck }: { readonly block: DeckBlock; readonly deck: PresentationDeck }) {
  if (block.type === "image") {
    return block.content ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={block.content}
        alt=""
        className="size-full object-cover"
        style={{ borderRadius: cqh(block.style?.radius ?? 0) }}
      />
    ) : (
      <div
        className="grid size-full place-items-center border border-dashed"
        style={{ borderColor: deck.theme.accent, color: deck.theme.body, fontSize: cqh(28) }}
      >
        Image
      </div>
    );
  }
  if (block.type === "shape") return null;
  return <>{block.content}</>;
}

export function DeckSlideCanvas({
  deck,
  slide,
  editing = false,
  selectedBlockId = null,
  onSelectBlock,
  onMoveBlock,
  className,
}: {
  readonly deck: PresentationDeck;
  readonly slide: DeckSlide;
  readonly editing?: boolean;
  readonly selectedBlockId?: string | null;
  readonly onSelectBlock?: (id: string | null) => void;
  /** Commit a block move to percent coordinates (drag). */
  readonly onMoveBlock?: (id: string, x: number, y: number) => void;
  readonly className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  const startDrag = (event: ReactPointerEvent, block: DeckBlock) => {
    if (!editing || !onMoveBlock) return;
    const root = rootRef.current;
    if (!root) return;
    event.preventDefault();
    const rect = root.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = block.x;
    const originY = block.y;
    const move = (moveEvent: globalThis.PointerEvent) => {
      const dx = ((moveEvent.clientX - startX) / rect.width) * 100;
      const dy = ((moveEvent.clientY - startY) / rect.height) * 100;
      const x = Math.min(120, Math.max(-20, Math.round((originX + dx) * 10) / 10));
      const y = Math.min(120, Math.max(-20, Math.round((originY + dy) * 10) / 10));
      onMoveBlock(block.id, x, y);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    // The 16:9 box: a padding-bottom ratio (56.25% = 9/16) reserves height in ANY
    // layout context (flex item, <button>, grid cell) - unlike `aspect-ratio`,
    // which collapses on a flex item or inside a button. The inner layer owns the
    // container-query context (so cqh font units resolve) and the positioned blocks.
    <div
      className={className}
      style={{ position: "relative", width: "100%", paddingBottom: "56.25%", overflow: "hidden" }}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-deselect on the canvas backdrop. */}
      <div
        ref={rootRef}
        style={{
          position: "absolute",
          inset: 0,
          containerType: "size",
          overflow: "hidden",
          ...deckBackgroundStyle(resolveSlideBackground(deck, slide)),
        }}
        onClick={editing ? () => onSelectBlock?.(null) : undefined}
      >
        {slide.blocks.map((block) => {
        const selected = editing && block.id === selectedBlockId;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: block selection is a pointer affordance in a canvas.
          <div
            key={block.id}
            style={{
              ...blockStyle(block, deck),
              ...(editing
                ? {
                    cursor: onMoveBlock ? "move" : "pointer",
                    outline: selected ? `2px solid ${deck.theme.accent}` : "none",
                    outlineOffset: "2px",
                  }
                : {}),
            }}
            onClick={editing
              ? (event) => {
                  event.stopPropagation();
                  onSelectBlock?.(block.id);
                }
              : undefined}
            onPointerDown={editing ? (event) => startDrag(event, block) : undefined}
          >
            <BlockContent block={block} deck={deck} />
          </div>
        );
        })}
      </div>
    </div>
  );
}
