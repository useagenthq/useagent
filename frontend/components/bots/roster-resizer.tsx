"use client";

import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { cx } from "@/utils/cx";

/** The roster must always fit a name, an outcome line and a time. */
export const ROSTER_MIN = 260;
export const ROSTER_MAX = 560;
/** The uncustomized width (md:w-80). */
export const ROSTER_DEFAULT = 320;
/** The thread beside the roster keeps at least this much of the split. */
const THREAD_FLOOR = 480;

const STORAGE_KEY = "useagent.bots-roster-width";

/** Clamp a wanted roster width to the range and to what the split can spare. */
export function rosterWidthFor({
  wanted,
  containerWidth,
  minimum = ROSTER_MIN,
  maximum = ROSTER_MAX,
}: {
  readonly wanted: number;
  readonly containerWidth: number;
  readonly minimum?: number;
  readonly maximum?: number;
}): number {
  const spare = Math.max(minimum, Math.min(maximum, containerWidth - THREAD_FLOOR));
  return Math.round(Math.min(Math.max(wanted, minimum), spare));
}

export function rosterMaximumFor(containerWidth: number): number {
  return rosterWidthFor({ wanted: ROSTER_MAX, containerWidth });
}

export function rosterLayoutFor({
  preferredWidth,
  containerWidth,
}: {
  readonly preferredWidth: number | null;
  readonly containerWidth: number;
}): { readonly width: number; readonly maximum: number } {
  return {
    width: rosterWidthFor({ wanted: preferredWidth ?? ROSTER_DEFAULT, containerWidth }),
    maximum: rosterMaximumFor(containerWidth),
  };
}

/** The roster sits on the LEFT, so its width is the pointer's distance from the container's left edge. */
export function rosterWidthFromPointer({
  containerLeft,
  containerWidth,
  pointerX,
}: {
  readonly containerLeft: number;
  readonly containerWidth: number;
  readonly pointerX: number;
}): number {
  return rosterWidthFor({ wanted: pointerX - containerLeft, containerWidth });
}

export function rosterWidthForKey({
  key,
  current,
  containerWidth,
}: {
  readonly key: string;
  readonly current: number;
  readonly containerWidth: number;
}): number | null {
  if (key === "ArrowRight") return rosterWidthFor({ wanted: current + 16, containerWidth });
  if (key === "ArrowLeft") return rosterWidthFor({ wanted: current - 16, containerWidth });
  if (key === "Home") return ROSTER_MIN;
  if (key === "End") return rosterWidthFor({ wanted: ROSTER_MAX, containerWidth });
  return null;
}

/**
 * The preferred roster width persists per browser; null means the CSS default.
 * The effective width is separately clamped to the space currently available,
 * so a temporary viewport contraction does not erase the user's preference.
 * Same mechanics as the session rail: the drag writes `--roster-w` on the
 * aside imperatively per animation frame and React state commits once on
 * pointer up, so nothing re-renders per move.
 */
export function useRosterWidth({
  containerRef,
  asideRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  asideRef: RefObject<HTMLElement | null>;
}) {
  const [preferredWidth, setPreferredWidth] = useState<number | null>(null);
  const [width, setWidth] = useState(ROSTER_DEFAULT);
  const [maximum, setMaximum] = useState(ROSTER_MAX);
  const preferredWidthRef = useRef<number | null>(null);
  const containerWidthRef = useRef(ROSTER_MAX + THREAD_FLOOR);
  const boundsRef = useRef<DOMRect | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  const persistPreferredWidth = useCallback((next: number | null) => {
    preferredWidthRef.current = next;
    setPreferredWidth(next);
    try {
      if (next === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Storage can be unavailable; the width still applies for this page.
    }
  }, []);
  const applyEffectiveWidth = useCallback(
    (containerWidth: number) => {
      containerWidthRef.current = containerWidth;
      const layout = rosterLayoutFor({
        preferredWidth: preferredWidthRef.current,
        containerWidth,
      });
      setMaximum((current) => (current === layout.maximum ? current : layout.maximum));
      setWidth((current) => (current === layout.width ? current : layout.width));
      asideRef.current?.style.setProperty("--roster-w", `${layout.width}px`);
    },
    [asideRef],
  );
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const bounds = container.getBoundingClientRect();
    let saved = Number.NaN;
    try {
      saved = Number(localStorage.getItem(STORAGE_KEY));
    } catch {
      // Storage can be unavailable; container observation still works.
    }
    if (Number.isFinite(saved) && saved >= ROSTER_MIN) {
      persistPreferredWidth(
        rosterWidthFor({ wanted: saved, containerWidth: ROSTER_MAX + THREAD_FLOOR }),
      );
    }
    applyEffectiveWidth(bounds.width);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const containerWidth = entries.at(-1)?.contentRect.width;
      if (containerWidth === undefined) return;
      boundsRef.current = null;
      applyEffectiveWidth(containerWidth);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [applyEffectiveWidth, containerRef, persistPreferredWidth]);
  const resizeFromPointer = useCallback(
    (pointerX: number) => {
      boundsRef.current ??= containerRef.current?.getBoundingClientRect() ?? null;
      const bounds = boundsRef.current;
      if (!bounds) return;
      const next = rosterWidthFromPointer({
        containerLeft: bounds.left,
        containerWidth: bounds.width,
        pointerX,
      });
      dragWidthRef.current = next;
      asideRef.current?.style.setProperty("--roster-w", `${next}px`);
    },
    [containerRef, asideRef],
  );
  const commit = useCallback(() => {
    boundsRef.current = null;
    const next = dragWidthRef.current;
    dragWidthRef.current = null;
    if (next === null) return;
    persistPreferredWidth(next);
    applyEffectiveWidth(containerWidthRef.current);
  }, [applyEffectiveWidth, persistPreferredWidth]);
  const reset = useCallback(() => {
    boundsRef.current = null;
    dragWidthRef.current = null;
    persistPreferredWidth(null);
    applyEffectiveWidth(containerWidthRef.current);
  }, [applyEffectiveWidth, persistPreferredWidth]);
  const resizeWithKeyboard = (key: string) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    const containerWidth = bounds?.width ?? ROSTER_MAX + THREAD_FLOOR;
    const next = rosterWidthForKey({ key, current: width, containerWidth });
    if (next === null) return;
    persistPreferredWidth(next);
    applyEffectiveWidth(containerWidth);
  };
  return { preferredWidth, width, maximum, resizeFromPointer, commit, reset, resizeWithKeyboard };
}

/**
 * The drag grip between the roster and the thread: the same visual grammar as
 * the session rail's grip (a hairline that shows on hover, focus or drag, with
 * a pill handle), coalesced to one width write per painted frame.
 */
export function RosterResizer({
  value,
  maximum,
  onMove,
  onCommit,
  onKeyDown,
  onReset,
}: {
  readonly value: number;
  readonly maximum: number;
  readonly onMove: (pointerX: number) => void;
  readonly onCommit: () => void;
  readonly onKeyDown: (key: string) => void;
  readonly onReset: () => void;
}) {
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const pendingXRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  const flush = () => {
    frameRef.current = null;
    if (pendingXRef.current === null) return;
    const x = pendingXRef.current;
    pendingXRef.current = null;
    onMove(x);
  };
  const finish = (element: HTMLHRElement, pointerId?: number) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    flush();
    if (pointerId !== undefined && element.hasPointerCapture(pointerId))
      element.releasePointerCapture(pointerId);
    onCommit();
  };

  return (
    <hr
      data-testid="roster-resize-grip"
      data-dragging={dragging}
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize the bots list; double-click to reset"
      aria-valuemin={ROSTER_MIN}
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
        frameRef.current ??= requestAnimationFrame(flush);
      }}
      onPointerUp={(event) => finish(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) => finish(event.currentTarget, event.pointerId)}
      onLostPointerCapture={(event) => finish(event.currentTarget)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        onKeyDown(event.key);
      }}
      onDoubleClick={onReset}
      className={cx(
        "peer relative -mx-2 hidden h-auto w-4 shrink-0 cursor-col-resize touch-none self-stretch border-0 bg-transparent outline-none md:block",
        "before:absolute before:inset-y-3 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors before:content-['']",
        "after:border-border-button-default after:bg-background-primary-default after:shadow-card after:absolute after:left-1/2 after:top-1/2 after:h-12 after:w-3 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:border after:transition-[border-color,background-color,box-shadow,transform] after:content-['']",
        "hover:before:bg-border-button-hover hover:after:border-accent-500 focus-visible:before:bg-accent-500 focus-visible:after:border-accent-500 focus-visible:after:ring-2 focus-visible:after:ring-accent-500/15",
        dragging &&
          "before:bg-accent-500 after:scale-110 after:border-accent-500 after:bg-accent-500/10",
      )}
    />
  );
}
