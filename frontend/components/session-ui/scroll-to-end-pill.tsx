"use client";

// useAgent component (NOT vendored): a quiet floating "Scroll to end" pill for a
// scoped scroll container. Self-contained - it tracks its own near-bottom state
// off the container's scroll (and viewport resizes), renders nothing while the
// reader is already at the bottom, and reuses the rail's reduced-motion check so
// the jump degrades gracefully. Drop it beside MessageScrollerRail; it does not
// touch the container's own stick-to-bottom logic (it only reads scroll offset).

import { RiArrowDownLine } from "@remixicon/react";
import { type RefObject, useEffect, useState } from "react";
import { prefersReducedMotion } from "./message-scroller-rail";

/** Distance from the bottom (px) under which the reader counts as "at the end" -
 *  matches the conversation's own stick-to-bottom threshold. */
const NEAR_BOTTOM_PX = 80;

export function ScrollToEndPill({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      // Only flip state on change - the scroll handler must stay allocation-free.
      setAtBottom((prev) => (prev === near ? prev : near));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // The viewport height changes (rail open/close, window resize) shift the
    // bottom without a scroll event; recompute on resize too.
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [scrollRef]);

  if (atBottom) return null;

  const scrollToEnd = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  return (
    <button
      type="button"
      data-session-ui="scroll-to-end"
      aria-label="Scroll to end"
      onClick={scrollToEnd}
      className="pointer-events-auto absolute bottom-4 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-button-default bg-background-primary-default px-3 py-1.5 text-caption-1-medium text-text-secondary shadow-md transition-colors hover:bg-background-primary-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      <RiArrowDownLine className="size-3.5" aria-hidden />
      Scroll to end
    </button>
  );
}
