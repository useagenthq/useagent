"use client";

// skynet-a component. Original work inspired by the beui.dev "Message Scroller"
// pattern: a slim vertical tick rail hugging the conversation's right edge, one
// tick per turn, the in-view turn highlighted, clicking a tick jumps to that turn.
// Rebuilt on OUR turn model + semantic tokens (not vendored code).
//
// No new state model: the ticks derive from the turns array, the in-view turn is
// tracked by ONE IntersectionObserver rooted on the existing scroll container, and
// jumping reuses that container's scroll (so the reader-aware stick-to-bottom logic
// in Conversation is never duplicated or fought).

import { type RefObject, useEffect, useRef, useState } from "react";
import { cleanPrompt } from "@/components/chat/types";
import { cnExt as cn } from "@/utils/cn";

/** Below this many turns the rail adds no navigational value, so it is hidden. */
export const MIN_TURNS_FOR_SCROLLER = 4;

export function shouldShowScrollerRail(turnCount: number): boolean {
  return turnCount >= MIN_TURNS_FOR_SCROLLER;
}

export type ScrollerTick = { id: string; snippet: string };

const SNIPPET_MAX = 40;

/** The first ~40 chars of a turn's cleaned prompt, for the tick's hover title. */
export function scrollerTickSnippet(prompt: string): string {
  const clean = cleanPrompt(prompt).replace(/\s+/g, " ").trim();
  if (clean.length <= SNIPPET_MAX) return clean;
  return `${clean.slice(0, SNIPPET_MAX).trimEnd()}…`;
}

export function deriveScrollerTicks(
  turns: readonly { run: { id: string; prompt: string } }[],
): ScrollerTick[] {
  return turns.map((t) => ({ id: t.run.id, snippet: scrollerTickSnippet(t.run.prompt) }));
}

/** The topmost turn currently intersecting the viewport is the one "in view";
 *  fall back to the last-known active index when nothing intersects (mid-fling). */
export function pickActiveTurnIndex(visible: ReadonlySet<number>, fallback: number): number {
  let min = -1;
  for (const index of visible) if (min === -1 || index < min) min = index;
  return min === -1 ? fallback : min;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The turn-jump rail. Renders nothing under MIN_TURNS_FOR_SCROLLER turns, and is
 * hidden on narrow viewports via a responsive class (no value on small screens).
 * The container is pointer-events-none so it never intercepts text selection; only
 * the tick buttons opt back in.
 */
export function MessageScrollerRail({
  turns,
  scrollRef,
}: {
  turns: readonly { run: { id: string; prompt: string } }[];
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const ticks = deriveScrollerTicks(turns);
  const idsRef = useRef<string[]>([]);
  idsRef.current = ticks.map((t) => t.id);
  const idsKey = idsRef.current.join("|");

  const [activeIndex, setActiveIndex] = useState(0);
  const visibleRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const container = scrollRef.current;
    const ids = idsRef.current;
    if (!container || ids.length < MIN_TURNS_FOR_SCROLLER) return;

    const idToIndex = new Map(ids.map((id, index) => [id, index] as const));
    visibleRef.current = new Set();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.runId;
          const index = id !== undefined ? idToIndex.get(id) : undefined;
          if (index === undefined) continue;
          if (entry.isIntersecting) visibleRef.current.add(index);
          else visibleRef.current.delete(index);
        }
        setActiveIndex((prev) => pickActiveTurnIndex(visibleRef.current, prev));
      },
      { root: container, threshold: 0 },
    );

    for (const el of container.querySelectorAll<HTMLElement>("[data-run-id]")) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, [scrollRef, idsKey]);

  if (ticks.length < MIN_TURNS_FOR_SCROLLER) return null;

  const jumpTo = (index: number) => {
    const container = scrollRef.current;
    const id = idsRef.current[index];
    if (!container || id === undefined) return;
    const el = container.querySelector<HTMLElement>(`[data-run-id="${CSS.escape(id)}"]`);
    if (!el) return;
    const top =
      container.scrollTop +
      (el.getBoundingClientRect().top - container.getBoundingClientRect().top);
    container.scrollTo({ top: top - 8, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  return (
    <nav
      data-session-ui="message-scroller-rail"
      aria-label="Jump to a turn"
      className="pointer-events-none absolute inset-y-6 right-1.5 z-10 hidden flex-col items-center justify-center gap-1 overflow-hidden lg:flex"
    >
      {ticks.map((tick, index) => {
        const active = index === activeIndex;
        return (
          <button
            key={tick.id}
            type="button"
            title={tick.snippet}
            aria-label={`Jump to turn ${index + 1}: ${tick.snippet}`}
            aria-current={active ? "true" : undefined}
            onClick={() => jumpTo(index)}
            className="group pointer-events-auto flex h-3 w-4 items-center justify-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-stroke-strong-950"
          >
            <span
              className={cn(
                "h-px rounded-full transition-all duration-200",
                active
                  ? "w-3.5 bg-text-strong-950"
                  : "w-2 bg-stroke-soft-200 group-hover:w-3 group-hover:bg-stroke-sub-300",
              )}
            />
          </button>
        );
      })}
    </nav>
  );
}
