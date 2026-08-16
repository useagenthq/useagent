"use client";

import { useRef, useState } from "react";
import { cnExt } from "@/utils/cn";

export const RAIL_MIN = 280;
export const RAIL_MAX = 960;
export const RAIL_DEFAULT = 480;

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

  const finishDrag = (element: HTMLHRElement, pointerId?: number) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
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
        if (draggingRef.current) onMove(event.clientX);
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
        "relative -mx-2 hidden h-auto w-4 shrink-0 cursor-col-resize touch-none self-stretch border-0 bg-transparent outline-none md:block",
        "before:bg-stroke-soft-200 before:absolute before:inset-y-3 before:left-1/2 before:w-px before:-translate-x-1/2 before:transition-colors before:content-['']",
        "after:border-stroke-soft-200 after:bg-bg-white-0 after:shadow-regular-xs after:absolute after:left-1/2 after:top-1/2 after:h-12 after:w-3 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:border after:transition-[border-color,background-color,box-shadow,transform] after:content-['']",
        "hover:before:bg-stroke-sub-300 hover:after:border-primary-base focus-visible:before:bg-primary-base focus-visible:after:border-primary-base focus-visible:after:ring-2 focus-visible:after:ring-primary-alpha-16",
        dragging &&
          "before:bg-primary-base after:scale-110 after:border-primary-base after:bg-primary-alpha-10",
      )}
    />
  );
}
