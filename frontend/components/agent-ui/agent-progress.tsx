// Ported from beui.dev registry "agent-progress"
// (components/agents/loading-states/agent-progress.tsx + lib/ease inlined).
// Re-expressed with our AlignUI tokens + Remixicon. A compact activity glyph, a swapping
// action verb, and a live tabular timer for longer-running work.
"use client";

import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import { useEffect, useState } from "react";

import { cx } from "@/utils/cx";

// -- motion tokens ---------------------------------------------------------
const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;

const GRID_CELLS = [
  { id: "top-left", delay: 0 },
  { id: "top-center", delay: 0.14 },
  { id: "top-right", delay: 0.28 },
  { id: "middle-left", delay: 0.42 },
  { id: "middle-center", delay: 0.56 },
  { id: "middle-right", delay: 0.7 },
  { id: "bottom-left", delay: 0.84 },
  { id: "bottom-center", delay: 0.98 },
  { id: "bottom-right", delay: 1.12 },
];

// -- rolling verb swap -----------------------------------------------------
const ROLL_BLUR = "blur(3px)";
const ROLL_VARIANTS: Variants = {
  initial: { opacity: 0, y: "70%", filter: ROLL_BLUR },
  animate: { opacity: 1, y: "0%", filter: "blur(0px)", transition: SPRING_SWAP },
  exit: { opacity: 0, y: "-70%", filter: ROLL_BLUR, transition: { duration: 0.14, ease: EASE_IN_OUT } },
};

function formatElapsed(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = (safeSeconds % 60).toFixed(1);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Compact activity indicator: a pulsing 3x3 glyph, a swapping action verb, and a live
 * tabular timer. Drive `elapsedSeconds` yourself, or leave it to self-count while `running`. */
export function AgentProgress({
  label = "Churning",
  elapsedSeconds,
  initialSeconds = 0,
  running = true,
  className,
}: {
  label?: string;
  elapsedSeconds?: number;
  initialSeconds?: number;
  running?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const [internalSeconds, setInternalSeconds] = useState(initialSeconds);

  useEffect(() => {
    if (elapsedSeconds !== undefined || !running) return;

    const startedAt = performance.now() - initialSeconds * 1000;
    const timer = window.setInterval(() => {
      setInternalSeconds((performance.now() - startedAt) / 1000);
    }, 100);

    return () => window.clearInterval(timer);
  }, [elapsedSeconds, initialSeconds, running]);

  const elapsed = elapsedSeconds ?? internalSeconds;

  return (
    <span
      role="status"
      aria-label={`${label}, in progress`}
      className={cx("inline-flex items-center gap-3 font-mono text-body-2-regular text-text-secondary", className)}
    >
      <span aria-hidden="true" className="grid size-5 shrink-0 grid-cols-3 gap-[2px] text-accent-500">
        {GRID_CELLS.map(({ id, delay }) => (
          <motion.span
            key={id}
            className="rounded-[1px] bg-current"
            animate={
              reduce
                ? { opacity: [0.35, 0.8, 0.35] }
                : { opacity: [0.28, 1, 0.28], scale: [0.72, 1, 0.72] }
            }
            transition={{ duration: 1.55, ease: EASE_IN_OUT, repeat: Infinity, delay }}
          />
        ))}
      </span>
      <span className="relative inline-flex overflow-hidden font-sans text-body-2-medium text-text-primary">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={label}
            variants={reduce ? undefined : ROLL_VARIANTS}
            initial={reduce ? false : "initial"}
            animate={reduce ? { opacity: 1 } : "animate"}
            exit={reduce ? { opacity: 0 } : "exit"}
            className="inline-block whitespace-nowrap will-change-[opacity,filter,transform]"
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </span>
      <span aria-hidden="true" className="tabular-nums text-text-tertiary">
        {formatElapsed(elapsed)}
      </span>
    </span>
  );
}

const VERBS = ["Churning", "Reasoning", "Searching docs", "Compiling", "Synthesizing"];
const VERB_MS = 2400;

/** Self-driving demo: cycles the action verb while the timer counts up on its own. */
export function AgentProgressDemo() {
  const [verb, setVerb] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setVerb((v) => (v + 1) % VERBS.length), VERB_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="flex w-full max-w-md items-center justify-center rounded-2xl border border-border-button-default bg-background-primary-default py-6 shadow-sm">
        <AgentProgress label={VERBS[verb]} running />
      </div>
    </div>
  );
}

export default AgentProgressDemo;
