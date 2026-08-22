"use client";

import { useRef, useState } from "react";
import { cx as cnExt } from "@/utils/cx";

export const RAIL_MIN = 280;
export const RAIL_MAX = 960;
export const RAIL_DEFAULT = 360;

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
  const containerMaximum = Math.min(containerWidth * 0.6, maximum);
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
  if (key === "ArrowLeft") return Math.min(current + 16, maximum);
  if (key === "ArrowRight") return Math.max(current - 16, minimum);
  if (key === "Home") return minimum;
  if (key === "End") return maximum;
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
