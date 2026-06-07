"use client";

// Turn-level render windowing for the session transcript. Only turns near the
// viewport (± OVERSCAN_VIEWPORTS heights) mount their real TurnBlock DOM; the
// rest are fixed-height placeholder rows sized from a measured-height cache
// (ResizeObserver on real rows) or a shape estimate before the first measure.
// Scroll position is anchor-stabilized: when a row above the topmost visible
// row changes height (a placeholder materializing at its true size, a late
// measure), the same delta is applied to scrollTop inside the ResizeObserver
// callback - after layout, before paint - so the reader's line never moves.
// Threads at or under SHORT_TRANSCRIPT_LIMIT bypass all of this and render
// exactly as before. All geometry decisions live in ./turn-window-model.

import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Turn } from "@/components/chat/conversation";
import { TurnUiStateProvider } from "./turn-ui-state";
import {
  computeRealRows,
  estimateTurnHeight,
  SHORT_TRANSCRIPT_LIMIT,
  scrollCorrection,
  selectAnchorFromLayout,
  TURN_GAP_PX,
} from "./turn-window-model";

/** Matches the conversation's stick-to-bottom threshold: while the reader is
 *  pinned near the bottom, the follow behavior owns scrollTop - never fight it
 *  with anchor corrections. */
const NEAR_BOTTOM_PX = 80;

/** Live turns and the tail are always real DOM - the streaming turn must
 *  render for the bottom-pinned follow behavior to keep working. */
function forcedIndices(turns: readonly Turn[]): number[] {
  const forced: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].live) forced.push(i);
  }
  if (turns.length > 0) forced.push(turns.length - 1);
  return forced;
}

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && b.isSubsetOf(a);
}

/** The scroller's top padding offsets every row from scrollTop's origin. */
function contentTop(el: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(el).paddingTop) || 0;
}

export function TurnWindow({
  turns,
  scrollRef,
  renderTurn,
}: {
  turns: readonly Turn[];
  /** The conversation's own scroll container - the window reads its viewport. */
  scrollRef: RefObject<HTMLDivElement | null>;
  renderTurn: (turn: Turn, index: number, windowOwnsRunMarker: boolean) => ReactNode;
}) {
  const bypass = turns.length <= SHORT_TRANSCRIPT_LIMIT;

  // Measured row heights by run id - the placeholder size source. Written only
  // from real rows' ResizeObserver measurements, so a row swapping back to a
  // placeholder keeps exactly the height it just had.
  const measuredRef = useRef(new Map<string, number>());
  // The height each row currently occupies in layout per our bookkeeping (the
  // placeholder style height, or the last real measurement) - the "before"
  // side of every anchor correction.
  const laidOutRef = useRef(new Map<string, number>());
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  // The rows that rendered real DOM in the latest commit (assigned below in a
  // layout effect, so the ResizeObserver callback - which fires after layout
  // effects - always sees the committed truth).
  const renderedRealRef = useRef<ReadonlySet<string>>(new Set());

  // Which rows render real DOM. null = before the first client measure: only
  // forced rows (live, tail) are real, so SSR and the first client render
  // agree and a huge thread never mounts fully just to be windowed.
  const [realKeys, setRealKeys] = useState<ReadonlySet<string> | null>(null);

  const heightOf = useCallback(
    (turn: Turn) => measuredRef.current.get(turn.run.id) ?? estimateTurnHeight(turn),
    [],
  );

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const list = turnsRef.current;
    if (list.length <= SHORT_TRANSCRIPT_LIMIT) return;
    const heights = list.map(heightOf);
    const real = computeRealRows(
      heights,
      TURN_GAP_PX,
      Math.max(0, el.scrollTop - contentTop(el)),
      el.clientHeight,
      forcedIndices(list),
    );
    const next = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      if (real[i]) next.add(list[i].run.id);
    }
    setRealKeys((prev) => (prev !== null && sameKeys(prev, next) ? prev : next));
  }, [scrollRef, heightOf]);

  // Row height changes land here (initial measure of a materialized row, late
  // content like images, reflow on container resize). ResizeObserver fires
  // after layout and before paint, so the scrollTop correction that keeps the
  // anchor row visually fixed is never visible as a jump.
  const onRowsMeasured = useCallback(
    (entries: ResizeObserverEntry[]) => {
      const el = scrollRef.current;
      if (!el) return;
      const list = turnsRef.current;
      if (list.length <= SHORT_TRANSCRIPT_LIMIT) return;
      const indexByKey = new Map(list.map((t, i) => [t.run.id, i] as const));
      const beforeHeights = list.map(
        (turn) => laidOutRef.current.get(turn.run.id) ?? heightOf(turn),
      );
      const realIndices = new Set<number>();
      for (let index = 0; index < list.length; index++) {
        if (renderedRealRef.current.has(list[index].run.id)) realIndices.add(index);
      }
      const scrollTop = Math.max(0, el.scrollTop - contentTop(el));
      const anchor = selectAnchorFromLayout(
        beforeHeights,
        realIndices,
        TURN_GAP_PX,
        scrollTop,
        el.clientHeight,
      );
      const changes: { index: number; delta: number }[] = [];
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.turnRow;
        if (key === undefined) continue;
        const height = entry.target.getBoundingClientRect().height;
        const previous = laidOutRef.current.get(key);
        laidOutRef.current.set(key, height);
        if (renderedRealRef.current.has(key)) measuredRef.current.set(key, height);
        const index = indexByKey.get(key);
        if (index === undefined || previous === undefined || previous === height) continue;
        changes.push({ index, delta: height - previous });
      }
      if (changes.length === 0) return;
      const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      if (!pinned) {
        const delta = scrollCorrection(changes, anchor);
        if (delta !== 0) el.scrollTop += delta;
      }
      recompute();
    },
    [scrollRef, heightOf, recompute],
  );

  // One shared observer for every row wrapper; per-key ref callbacks are cached
  // so React never detaches/reattaches them across renders.
  const rowObserverRef = useRef<ResizeObserver | null>(null);
  const rowRefsRef = useRef(new Map<string, (node: HTMLDivElement | null) => () => void>());
  const rowRef = (key: string) => {
    let callback = rowRefsRef.current.get(key);
    if (!callback) {
      callback = (node: HTMLDivElement | null) => {
        if (node) {
          rowObserverRef.current ??= new ResizeObserver(onRowsMeasured);
          rowObserverRef.current.observe(node);
        }
        return () => {
          if (node) rowObserverRef.current?.unobserve(node);
        };
      };
      rowRefsRef.current.set(key, callback);
    }
    return callback;
  };
  useEffect(() => () => rowObserverRef.current?.disconnect(), []);

  // Scroll + container resize drive the window, coalesced to one recompute per
  // animation frame - placeholder swaps happen well outside the viewport, so a
  // frame of latency is invisible.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || bypass) return;
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recompute();
      });
    };
    el.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scrollRef, bypass, recompute]);

  // Turns changing (new turn, settle, fold regroup) recompute the window before
  // paint, and prune cache entries for runs that left the thread.
  useLayoutEffect(() => {
    const ids = new Set(turns.map((t) => t.run.id));
    for (const key of measuredRef.current.keys()) {
      if (!ids.has(key)) measuredRef.current.delete(key);
    }
    for (const key of laidOutRef.current.keys()) {
      if (!ids.has(key)) laidOutRef.current.delete(key);
    }
    for (const key of rowRefsRef.current.keys()) {
      if (!ids.has(key)) rowRefsRef.current.delete(key);
    }
    if (!bypass) recompute();
  }, [turns, bypass, recompute]);

  const lastIndex = turns.length - 1;
  const realNow = new Set<string>();
  let rows: ReactNode = null;
  if (!bypass) {
    rows = turns.map((turn, index) => {
      const key = turn.run.id;
      const real = index === lastIndex || turn.live || (realKeys?.has(key) ?? false);
      if (real) realNow.add(key);
      const height = heightOf(turn);
      // A placeholder occupies exactly this height - record it as laid out so
      // the first real measurement corrects scroll by the true delta.
      if (!real) laidOutRef.current.set(key, height);
      return (
        <TurnWindowRow
          key={key}
          turn={turn}
          index={index}
          windowed
          real={real}
          height={height}
          rowRef={rowRef(key)}
          renderTurn={renderTurn}
        />
      );
    });
  }
  useLayoutEffect(() => {
    renderedRealRef.current = realNow;
  });

  // Short threads render exactly as before the window existed: no wrappers, no
  // observers, identical DOM.
  if (bypass) {
    return (
      <>
        {turns.map((turn, index) => (
          <TurnWindowRow
            key={turn.run.id}
            turn={turn}
            index={index}
            windowed={false}
            real
            height={0}
            renderTurn={renderTurn}
          />
        ))}
      </>
    );
  }
  return <>{rows}</>;
}

function TurnWindowRow({
  turn,
  index,
  windowed,
  real,
  height,
  rowRef,
  renderTurn,
}: {
  turn: Turn;
  index: number;
  windowed: boolean;
  real: boolean;
  height: number;
  rowRef?: (node: HTMLDivElement | null) => () => void;
  renderTurn: (turn: Turn, index: number, windowOwnsRunMarker: boolean) => ReactNode;
}) {
  const content = real ? (
    renderTurn(turn, index, windowed)
  ) : (
    <div style={{ height }} aria-hidden data-testid="turn-placeholder" />
  );
  return (
    <TurnUiStateProvider>
      {windowed ? (
        // This wrapper is the sole rail marker for a windowed turn. TurnBlock
        // omits its marker in this mode, so IntersectionObserver never tracks
        // duplicate nodes for the same run.
        <div
          ref={rowRef}
          data-turn-row={turn.run.id}
          data-run-id={turn.run.id}
        >
          {content}
        </div>
      ) : (
        content
      )}
    </TurnUiStateProvider>
  );
}
