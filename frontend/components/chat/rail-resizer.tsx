"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { cx as cnExt } from "@/utils/cx";

// 360px keeps the terminal pane at ~42 columns (13px JetBrains Mono minus the
// pane padding) - the rail must never be resizable below a usable terminal.
export const RAIL_MIN = 360;
export const RAIL_MAX = 960;
export const RAIL_DEFAULT = 360;

// The narrowest split container that can hold BOTH panes side by side: the
// conversation floor (md:min-w-80 = 320px) beside the rail minimum. Below this
// the rail falls back to the slide-over sheet instead of crushing the terminal.
export const SPLIT_MIN = 320 + RAIL_MIN;

/**
 * True while the split container is too narrow for conversation + rail side by
 * side. Decisions land on the SETTLED width (trailing debounce): the sidebar
 * fold animates its width, and a mid-transition flip would bounce the rail
 * into and out of the sheet.
 */
export function useSplitTooNarrow(containerRef: RefObject<HTMLDivElement | null>): boolean {
  const [tooNarrow, setTooNarrow] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let width = el.getBoundingClientRect().width;
    setTooNarrow(width < SPLIT_MIN);
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      width = entries.at(-1)?.contentRect.width ?? width;
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        setTooNarrow(width < SPLIT_MIN);
      }, 250);
    });
    observer.observe(el);
    return () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      observer.disconnect();
    };
  }, [containerRef]);
  return tooNarrow;
}

/**
 * Rail width in px, persisted per browser; null → the 28.6% CSS default.
 * Loaded in an effect (not the initializer) so SSR and first client render
 * agree.
 *
 * The drag itself is ZERO-React: each (rAF-coalesced) pointer move writes the
 * rail's `--rail-w` var imperatively against container bounds cached once per
 * drag - no layout read, no setState, no re-render per move. React state (and
 * localStorage) commit ONCE on pointerup via persistRailWidth; the committed
 * style prop then re-writes the same var value, so nothing jumps.
 */
export function useRailWidth({
  containerRef,
  railRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  railRef: RefObject<HTMLElement | null>;
}) {
  const [railWidth, setRailWidth] = useState<number | null>(null);
  useEffect(() => {
    const saved = Number(localStorage.getItem("useagent.rail-width"));
    if (!Number.isFinite(saved) || saved < RAIL_MIN) return;
    // Apply the saved width through the same 0.6-of-container ceiling as the
    // drag/keyboard paths: a width persisted on a wide desktop must never
    // starve the conversation on a narrower window (tablet split).
    const bounds = containerRef.current?.getBoundingClientRect();
    const containerMax = bounds ? Math.min(bounds.width * 0.6, RAIL_MAX) : RAIL_MAX;
    setRailWidth(Math.round(Math.max(RAIL_MIN, Math.min(saved, containerMax))));
  }, [containerRef]);
  const dragBoundsRef = useRef<DOMRect | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  const resizeRailFromPointer = useCallback(
    (pointerX: number) => {
      dragBoundsRef.current ??= containerRef.current?.getBoundingClientRect() ?? null;
      const bounds = dragBoundsRef.current;
      if (!bounds) return;
      const width = railWidthFromPointer({
        containerRight: bounds.right,
        containerWidth: bounds.width,
        pointerX,
      });
      dragWidthRef.current = width;
      railRef.current?.style.setProperty("--rail-w", `${width}px`);
    },
    [containerRef, railRef],
  );
  const persistRailWidth = useCallback(() => {
    dragBoundsRef.current = null;
    const width = dragWidthRef.current;
    dragWidthRef.current = null;
    if (width === null) return; // pointerdown without movement - nothing to commit
    setRailWidth(width);
    localStorage.setItem("useagent.rail-width", String(width));
  }, []);
  const resetRailWidth = useCallback(() => {
    dragBoundsRef.current = null;
    dragWidthRef.current = null;
    // Clear the imperative var too: a drag that was never committed lives only
    // on the element, where React's style diffing would not remove it.
    railRef.current?.style.removeProperty("--rail-w");
    setRailWidth(null);
    localStorage.removeItem("useagent.rail-width");
  }, [railRef]);
  function resizeRailWithKeyboard(key: string) {
    const bounds = containerRef.current?.getBoundingClientRect();
    const containerMax = bounds ? Math.min(bounds.width * 0.6, RAIL_MAX) : RAIL_MAX;
    const ratioDefault = bounds ? Math.round(bounds.width * 0.286) : RAIL_DEFAULT;
    const current = railWidth ?? Math.max(RAIL_MIN, Math.min(ratioDefault, containerMax));
    const next = railWidthForKey({ key, current, maximum: containerMax });
    if (next === null) return;
    const rounded = Math.round(next);
    setRailWidth(rounded);
    localStorage.setItem("useagent.rail-width", String(rounded));
  }
  return { railWidth, resizeRailFromPointer, persistRailWidth, resetRailWidth, resizeRailWithKeyboard };
}

export function railWidthFromPointer({
  containerRight,
  containerWidth,
  pointerX,
  edgeInset = 12,
  minimum = RAIL_MIN,
  maximum = RAIL_MAX,
}: {
  readonly containerRight: number;
  readonly containerWidth: number;
  readonly pointerX: number;
  readonly edgeInset?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}): number {
  const containerMaximum = Math.max(minimum, Math.min(containerWidth * 0.6, maximum));
  return Math.round(
    Math.min(Math.max(containerRight - edgeInset - pointerX, minimum), containerMaximum),
  );
}

export function railWidthForKey({
  key,
  current,
  maximum,
  minimum = RAIL_MIN,
}: {
  readonly key: string;
  readonly current: number;
  readonly maximum: number;
  readonly minimum?: number;
}): number | null {
  const boundedMaximum = Math.max(minimum, maximum);
  if (key === "ArrowLeft") return Math.min(current + 16, boundedMaximum);
  if (key === "ArrowRight") return Math.max(current - 16, minimum);
  if (key === "Home") return minimum;
  if (key === "End") return boundedMaximum;
  return null;
}

export function RailResizer({
  value,
  minimum = RAIL_MIN,
  maximum = RAIL_MAX,
  onMove,
  onCommit,
  onKeyDown,
  onReset,
}: {
  readonly value: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly onMove: (pointerX: number) => void;
  readonly onCommit: () => void;
  readonly onKeyDown: (key: string) => void;
  readonly onReset: () => void;
}) {
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  // Pointer moves can outpace the display; buffer the newest clientX and emit at
  // most ONE onMove per animation frame so the consumer pays one width write per
  // painted frame, never one per pointer event.
  const pendingXRef = useRef<number | null>(null);
  const moveFrameRef = useRef<number | null>(null);

  const flushMove = () => {
    moveFrameRef.current = null;
    if (pendingXRef.current === null) return;
    const pointerX = pendingXRef.current;
    pendingXRef.current = null;
    onMove(pointerX);
  };

  const finishDrag = (element: HTMLHRElement, pointerId?: number) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    // Apply the last buffered move first so the commit sees the final width.
    if (moveFrameRef.current !== null) cancelAnimationFrame(moveFrameRef.current);
    flushMove();
    if (pointerId !== undefined && element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
    onCommit();
  };

  return (
    <hr
      data-testid="rail-resize-grip"
      data-dragging={dragging}
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize the side panel; double-click to reset"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      onPointerDown={(event) => {
        event.preventDefault();
        draggingRef.current = true;
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return;
        pendingXRef.current = event.clientX;
        moveFrameRef.current ??= requestAnimationFrame(flushMove);
      }}
      onPointerUp={(event) => finishDrag(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) => finishDrag(event.currentTarget, event.pointerId)}
      onLostPointerCapture={(event) => finishDrag(event.currentTarget)}
      onKeyDown={(event) => {
        const supported = ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key);
        if (!supported) return;
        event.preventDefault();
        onKeyDown(event.key);
      }}
      onDoubleClick={onReset}
      className={cnExt(
        // `peer`: the rail <section> that follows suppresses its width transition
        // while this grip reports data-dragging (peer-data-[dragging=true]).
        "peer relative -mx-2 hidden h-auto w-4 shrink-0 cursor-col-resize touch-none self-stretch border-0 bg-transparent outline-none md:block",
        // The hairline stays INVISIBLE at rest (the panel edge reads cleaner without
        // a full-height rule) and appears on hover, keyboard focus, or drag.
        "before:absolute before:inset-y-3 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors before:content-['']",
        "after:border-border-button-default after:bg-background-primary-default after:shadow-card after:absolute after:left-1/2 after:top-1/2 after:h-12 after:w-3 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:border after:transition-[border-color,background-color,box-shadow,transform] after:content-['']",
        "hover:before:bg-border-button-hover hover:after:border-accent-500 focus-visible:before:bg-accent-500 focus-visible:after:border-accent-500 focus-visible:after:ring-2 focus-visible:after:ring-accent-500/15",
        dragging &&
          "before:bg-accent-500 after:scale-110 after:border-accent-500 after:bg-accent-500/10",
      )}
    />
  );
}
