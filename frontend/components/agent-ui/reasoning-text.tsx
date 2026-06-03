// Ported from beui.dev registry "reasoning-text" (components/agents/loading-states.tsx +
// agent-disclosure, lib/ease, and the inlined text-shimmer lib). Re-expressed with our
// tokens + Remixicon. A collapsible chain-of-thought block: a shimmering "thinking"
// header that resolves to a "Thought for Ns" summary, revealing the reasoning trace below.
"use client";

import { RiArrowDownSLine, RiSparkling2Line } from "@remixicon/react";
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { cx } from "@/utils/cx";

// -- motion tokens ---------------------------------------------------------
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;

// -- inlined text-shimmer lib (gradient mapped to our ink tokens) ----------
const TEXT_SHIMMER_KEYFRAMES =
  "@keyframes agent-reasoning-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}";
const TEXT_SHIMMER_CLASS_NAME =
  "bg-[length:200%_100%] bg-clip-text text-transparent bg-[linear-gradient(110deg,var(--color-text-tertiary)_30%,var(--color-text-primary)_50%,var(--color-text-tertiary)_70%)]";
function textShimmerStyle(duration: number): CSSProperties {
  return { animation: `agent-reasoning-shimmer ${duration}s linear infinite` };
}

const DEFAULT_PHRASES = [
  "Thinking",
  "Reading the context",
  "Connecting the details",
  "Forming a response",
];

// -- cycling shimmer phrase (the live "thinking" state) --------------------
function ReasoningPhrase({
  phrases,
  interval,
  shimmerDuration,
}: {
  phrases: string[];
  interval: number;
  shimmerDuration: number;
}) {
  const reduce = useReducedMotion() ?? false;
  const [index, setIndex] = useState(0);
  const statusId = useId();
  const safePhrases = phrases.length > 0 ? phrases : DEFAULT_PHRASES;
  const phrase = safePhrases[index % safePhrases.length];
  const longestPhrase = safePhrases.reduce((longest, current) =>
    current.length > longest.length ? current : longest,
  );

  useEffect(() => {
    if (safePhrases.length < 2) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % safePhrases.length);
    }, Math.max(600, interval));
    return () => window.clearInterval(timer);
  }, [interval, safePhrases.length]);

  return (
    <>
      <style>{TEXT_SHIMMER_KEYFRAMES}</style>
      <span
        role="status"
        aria-live="polite"
        aria-labelledby={statusId}
        className="inline-flex min-w-0 items-center text-body-2-medium"
      >
        <span aria-hidden="true" className="grid min-w-0 overflow-hidden text-left">
          <span className="invisible col-start-1 row-start-1 whitespace-nowrap">{longestPhrase}...</span>
          <AnimatePresence initial={false}>
            <motion.span
              key={phrase}
              className={cx(
                "col-start-1 row-start-1 inline-block justify-self-start whitespace-nowrap will-change-[opacity,transform]",
                TEXT_SHIMMER_CLASS_NAME,
              )}
              style={textShimmerStyle(shimmerDuration)}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 3 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
              transition={{ duration: reduce ? 0.12 : 0.2, ease: EASE_OUT }}
            >
              {phrase}...
            </motion.span>
          </AnimatePresence>
        </span>
        <span id={statusId} className="sr-only">
          {phrase}
        </span>
      </span>
    </>
  );
}

// -- collapsible disclosure ------------------------------------------------
interface AgentDisclosureProps extends Omit<HTMLMotionProps<"div">, "animate" | "initial"> {
  open: boolean;
  openHeight?: CSSProperties["height"];
}

function AgentDisclosure({
  open,
  openHeight = "auto",
  className,
  style,
  transition,
  ...props
}: AgentDisclosureProps) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      {...props}
      aria-hidden={!open}
      inert={!open}
      initial={false}
      animate={
        reduce
          ? { opacity: open ? 1 : 0 }
          : {
              opacity: open ? 1 : 0,
              clipPath: open ? "inset(0 0 0% 0)" : "inset(0 0 100% 0)",
              y: open ? 0 : -4,
            }
      }
      transition={transition ?? { duration: reduce ? 0 : open ? 0.22 : 0.14, ease: EASE_OUT }}
      className={cx("overflow-hidden", className)}
      style={{
        ...style,
        height: open ? openHeight : 0,
        pointerEvents: open ? undefined : "none",
        transformOrigin: "top",
      }}
    />
  );
}

/** Collapsible chain-of-thought block. While `thinking`, the header shimmers through
 * `phrases`; once resolved it settles to "Thought for Ns" and reveals the reasoning trace. */
export function ReasoningBlock({
  reasoning,
  thinking = false,
  seconds,
  phrases = DEFAULT_PHRASES,
  interval = 1800,
  shimmerDuration = 2.2,
  defaultOpen,
  maxHeight = 224,
  className,
}: {
  reasoning: ReactNode;
  thinking?: boolean;
  seconds?: number;
  phrases?: string[];
  interval?: number;
  shimmerDuration?: number;
  defaultOpen?: boolean;
  maxHeight?: number;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [currentOpen, setCurrentOpen] = useState(defaultOpen ?? thinking);
  const setOpen = useCallback((next: boolean) => setCurrentOpen(next), []);

  // Follow the model: expand while it thinks, collapse once the thought resolves.
  const previousThinking = useRef(thinking);
  useEffect(() => {
    if (defaultOpen !== undefined) return;
    if (previousThinking.current && !thinking) setOpen(false);
    if (!previousThinking.current && thinking) setOpen(true);
    previousThinking.current = thinking;
  }, [defaultOpen, setOpen, thinking]);

  // Keep the newest reasoning in view while it streams open.
  useEffect(() => {
    if (!thinking || !currentOpen) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const frame = requestAnimationFrame(() => {
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduce ? "auto" : "smooth" });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [currentOpen, reasoning, reduce, thinking]);

  return (
    <section
      aria-label="Agent reasoning"
      className={cx(
        "w-full overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-sm",
        className,
      )}
    >
      <button
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        className="group flex h-11 w-full items-center gap-2.5 rounded-2xl px-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <span
          aria-hidden="true"
          className={cx(
            "grid size-6 shrink-0 place-items-center text-text-secondary transition-colors",
            thinking && "text-accent-500",
          )}
        >
          <RiSparkling2Line className={cx("size-4", thinking && !reduce && "animate-pulse")} />
        </span>

        <span className="min-w-0 flex-1">
          {thinking ? (
            <ReasoningPhrase phrases={phrases} interval={interval} shimmerDuration={shimmerDuration} />
          ) : (
            <span className="truncate text-body-2-medium text-text-primary">
              {seconds === undefined ? "Reasoning" : `Thought for ${seconds}s`}
            </span>
          )}
        </span>

        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="shrink-0 text-text-tertiary transition-colors group-hover:text-text-secondary"
        >
          <RiArrowDownSLine className="size-4" />
        </motion.span>
      </button>

      <AgentDisclosure id={contentId} role="region" aria-labelledby={triggerId} open={currentOpen}>
        <div
          ref={viewportRef}
          className="overflow-y-auto px-3.5 pb-3.5"
          style={{ maxHeight, scrollbarWidth: "none" }}
        >
          <div className="border-l border-border-button-default pl-3.5 text-body-2-regular leading-relaxed text-text-secondary">
            {reasoning}
          </div>
        </div>
      </AgentDisclosure>
    </section>
  );
}

const DEMO_STEPS: string[] = [
  "The user wants a collapsible reasoning block, so I should mirror the disclosure pattern the sibling agent components already use.",
  "I'll shimmer the header through a few thinking phrases while streaming, then settle to a resolved summary once the thought completes.",
  "Tokens map cleanly onto the AlignUI ink and stroke scale, so no new colors are needed and the block stays on-brand.",
  "Finally I loop the whole sequence so the demo drives itself without any interaction.",
];

const STREAM_MS = 1200;
const REST_MS = 2600;

/** Self-driving demo: streams a chain of thought line by line, resolves to a summary,
 * then collapses and loops. */
export function ReasoningTextDemo() {
  const [revealed, setRevealed] = useState(1);
  const thinking = revealed < DEMO_STEPS.length;

  useEffect(() => {
    if (thinking) {
      const id = setTimeout(() => setRevealed((n) => n + 1), STREAM_MS);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setRevealed(1), REST_MS);
    return () => clearTimeout(id);
  }, [thinking, revealed]);

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="w-full max-w-md">
        <ReasoningBlock
          thinking={thinking}
          seconds={7}
          reasoning={
            <div className="space-y-2">
              {DEMO_STEPS.slice(0, revealed).map((step, i) => (
                <p key={i}>{step}</p>
              ))}
            </div>
          }
        />
      </div>
    </div>
  );
}

export default ReasoningTextDemo;
