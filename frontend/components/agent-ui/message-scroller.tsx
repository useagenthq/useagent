// Ported from beui.dev registry "message-scroller" (components/agents/message-scroller.tsx +
// lib/ease inlined). Re-expressed with our tokens + Remixicon. An auto-sticking scroll
// container that pins streamed output to the live edge while the reader stays near the bottom,
// and surfaces a "jump to latest" affordance the moment they scroll away.
"use client";

import { RiArrowDownSLine } from "@remixicon/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ComponentPropsWithRef,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cx } from "@/utils/cx";

// -- motion tokens ---------------------------------------------------------
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30, mass: 0.6 } as const;

interface MessageScrollerProps extends ComponentPropsWithRef<"div"> {
  /** Keep streamed output pinned while the reader remains near the end. */
  followOutput?: boolean;
  /** Distance from the end that still counts as following the output. */
  followThreshold?: number;
  /** Smoothly follow growing content. */
  smooth?: boolean;
  /** Reports when the reader leaves or returns to the live edge. */
  onFollowChange?: (following: boolean) => void;
  /** Accessible label for the scrollable transcript. */
  label?: string;
  /** Marks the transcript as waiting for more streamed content. */
  busy?: boolean;
  /** Label for the jump-to-latest control. */
  jumpLabel?: string;
  viewportClassName?: string;
  contentClassName?: string;
  viewportRef?: Ref<HTMLElement>;
}

/** Auto-sticking scroll container: pins the newest content to the live edge while the reader
 * stays near the bottom, and reveals a jump-to-latest button once they scroll up. */
export function MessageScroller({
  followOutput = true,
  followThreshold = 56,
  smooth = true,
  onFollowChange,
  label = "Conversation",
  busy,
  jumpLabel = "Jump to latest",
  viewportClassName,
  contentClassName,
  viewportRef: externalViewportRef,
  className,
  children,
  ...props
}: MessageScrollerProps) {
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(followOutput);
  const programmaticScrollRef = useRef(false);
  const scrollTimerRef = useRef<number | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const [following, setFollowingState] = useState(followOutput);

  const setViewportRef = useCallback(
    (node: HTMLElement | null) => {
      viewportRef.current = node;
      if (typeof externalViewportRef === "function") {
        externalViewportRef(node);
      } else if (externalViewportRef) {
        externalViewportRef.current = node;
      }
    },
    [externalViewportRef],
  );

  const setFollowing = useCallback(
    (next: boolean) => {
      if (followingRef.current === next) return;
      followingRef.current = next;
      setFollowingState(next);
      onFollowChange?.(next);
    },
    [onFollowChange],
  );

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    programmaticScrollRef.current = true;
    if (typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    } else {
      viewport.scrollTop = viewport.scrollHeight;
    }
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(
      () => {
        programmaticScrollRef.current = false;
      },
      behavior === "smooth" ? 320 : 0,
    );
  }, []);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || programmaticScrollRef.current) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setFollowing(distance <= followThreshold);
  }, [followThreshold, setFollowing]);

  const leaveLiveEdge = useCallback(() => {
    programmaticScrollRef.current = false;
  }, []);

  const jumpToLatest = useCallback(() => {
    setFollowing(true);
    scrollToEnd(reduce || !smooth ? "auto" : "smooth");
  }, [reduce, scrollToEnd, setFollowing, smooth]);

  useLayoutEffect(() => {
    followingRef.current = followOutput;
    setFollowingState(followOutput);
    if (!followOutput) return;
    frameRef.current = requestAnimationFrame(() => scrollToEnd("auto"));
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [followOutput, scrollToEnd]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!followOutput || !followingRef.current) return;
      scrollToEnd(reduce || !smooth ? "auto" : "smooth");
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [followOutput, reduce, scrollToEnd, smooth]);

  useEffect(
    () => () => {
      if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return (
    <div data-slot="message-scroller" className={cx("relative min-h-0", className)} {...props}>
      <section
        ref={setViewportRef}
        aria-label={label}
        onScroll={handleScroll}
        onWheel={leaveLiveEdge}
        onTouchStart={leaveLiveEdge}
        onKeyDown={(event) => {
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) leaveLiveEdge();
        }}
        className={cx(
          "h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring",
          viewportClassName,
        )}
      >
        <div
          ref={contentRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={busy}
          className={contentClassName}
        >
          {children}
        </div>
      </section>

      <AnimatePresence>
        {!following ? (
          <motion.button
            type="button"
            onClick={jumpToLatest}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.9 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.9 }}
            whileTap={reduce ? undefined : { scale: 0.94 }}
            transition={reduce ? { duration: 0.12 } : SPRING_PRESS}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-button-primary py-1.5 pl-3 pr-2.5 text-caption-1-regular font-medium text-text-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2"
          >
            {jumpLabel}
            <RiArrowDownSLine className="size-4" />
          </motion.button>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

type DemoMessage = { id: number; from: "user" | "assistant"; text: string };

const DEMO_THREAD: DemoMessage[] = [
  { id: 1, from: "user", text: "Give me the state of the launch - what shipped and what is still open?" },
  { id: 2, from: "assistant", text: "The composer, streaming responses and the approval flow all shipped this week. Two items remain open." },
  { id: 3, from: "user", text: "Which two, and who owns them?" },
  { id: 4, from: "assistant", text: "Rate-limiting on the tool API (owned by infra) and the mobile keyboard inset bug (owned by the app team)." },
  { id: 5, from: "user", text: "Any risk to the Friday demo?" },
  { id: 6, from: "assistant", text: "Low. The keyboard bug is cosmetic and rate-limiting only affects heavy parallel runs, which the demo will not hit." },
  { id: 7, from: "user", text: "Great. Draft a short status note for the channel." },
  { id: 8, from: "assistant", text: "Done - pinned a summary: three features shipped, two known issues tracked, demo on track for Friday." },
];

const STEP_MS = 1600;

/** Self-driving demo: streams the transcript one message at a time on a loop so the
 * container demonstrates its auto-stick behavior; scroll up mid-stream to reveal the jump button. */
export function MessageScrollerDemo() {
  const [count, setCount] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      setCount((current) => (current >= DEMO_THREAD.length ? 1 : current + 1));
    }, STEP_MS);
    return () => clearInterval(id);
  }, []);

  const visible = DEMO_THREAD.slice(0, count);

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="w-full max-w-md">
        <div className="h-80 overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-sm">
          <MessageScroller
            busy={count < DEMO_THREAD.length}
            className="h-full"
            contentClassName="flex flex-col gap-3 p-4"
          >
            <AnimatePresence initial={false}>
              {visible.map((message) => (
                <motion.div
                  key={message.id}
                  layout="position"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22, ease: EASE_OUT }}
                  className={cx(
                    "flex w-full",
                    message.from === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={cx(
                      "max-w-[82%] rounded-2xl px-3.5 py-2.5 text-body-2-regular leading-5",
                      message.from === "user"
                        ? "bg-accent-500 text-text-white"
                        : "bg-background-secondary-default text-text-primary",
                    )}
                  >
                    {message.text}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </MessageScroller>
        </div>
      </div>
    </div>
  );
}

export default MessageScrollerDemo;
