// Ported from beui.dev registry "motion/loader" (components/motion/loader.tsx + lib/ease
// inlined). Re-expressed with our AlignUI tokens + Remixicon. A reusable multi-variant
// working indicator plus an agent status card that walks through thinking / searching /
// running / done phases with a rolling label and a reduced-motion fallback.
"use client";

import { RiCheckLine } from "@remixicon/react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from "motion/react";
import { type ReactNode, useEffect, useId, useState } from "react";

import { cx } from "@/utils/cx";

// -- motion tokens ---------------------------------------------------------
const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const SPRING_SWAP = { type: "spring", stiffness: 460, damping: 30, mass: 0.55 } as const;

// Reduced motion keeps a calm opacity pulse and drops every transform.
const REDUCED = {
  animate: { opacity: [1, 0.4, 1] },
  transition: { duration: 1.4, ease: EASE_IN_OUT, repeat: Number.POSITIVE_INFINITY },
};

export type LoaderVariant =
  | "spinner"
  | "dots"
  | "bars"
  | "dot-matrix"
  | "comet"
  | "helix"
  | "ascii";

// Terminal-style frame set - the loader a CLI agent cycles through.
const ASCII_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface LoaderProps {
  /** Which animation to render. */
  variant?: LoaderVariant;
  /** Base square size in px. Everything scales from this. */
  size?: number;
  /** Seconds per animation cycle. */
  speed?: number;
  /** Accessible label announced to screen readers. */
  label?: string;
  className?: string;
}

/** Reusable working indicator. Inherits color from `currentColor`; pick a `variant`. */
export function Loader({
  variant = "spinner",
  size = 24,
  speed = 1,
  label = "Loading",
  className,
}: LoaderProps) {
  const reduce = useReducedMotion() ?? false;
  const part = { size, speed, reduce };

  return (
    <span
      role="status"
      aria-label={label}
      className={cx("inline-flex items-center justify-center text-text-primary", className)}
    >
      {variant === "spinner" && <Spinner {...part} />}
      {variant === "dots" && <Dots {...part} />}
      {variant === "bars" && <Bars {...part} />}
      {variant === "dot-matrix" && <DotMatrix {...part} />}
      {variant === "comet" && <Comet {...part} />}
      {variant === "helix" && <Helix {...part} />}
      {variant === "ascii" && <Ascii {...part} />}
      <span className="sr-only">{label}</span>
    </span>
  );
}

interface PartProps {
  size: number;
  speed: number;
  reduce: boolean;
}

function Spinner({ size, speed, reduce }: PartProps) {
  const stroke = Math.max(2, size * 0.09);
  const r = (size - stroke) / 2;
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      animate={reduce ? REDUCED.animate : { rotate: 360 }}
      transition={
        reduce
          ? REDUCED.transition
          : { duration: speed, ease: "linear", repeat: Number.POSITIVE_INFINITY }
      }
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.2}
        strokeWidth={stroke}
      />
      <path
        d={`M ${size / 2} ${size / 2 - r} A ${r} ${r} 0 0 1 ${size / 2 + r} ${size / 2}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
      />
    </motion.svg>
  );
}

function Dots({ size, speed, reduce }: PartProps) {
  const dot = size * 0.24;
  return (
    <span className="flex items-center" style={{ gap: size * 0.14 }}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="rounded-full bg-current"
          style={{ width: dot, height: dot }}
          animate={
            reduce
              ? { opacity: [0.4, 1, 0.4] }
              : { y: [0, -size * 0.3, 0], opacity: [0.5, 1, 0.5] }
          }
          transition={{
            duration: speed,
            ease: EASE_IN_OUT,
            repeat: Number.POSITIVE_INFINITY,
            delay: i * speed * 0.16,
          }}
        />
      ))}
    </span>
  );
}

function Bars({ size, speed, reduce }: PartProps) {
  const bar = size * 0.16;
  return (
    <span className="flex items-center" style={{ gap: size * 0.1, height: size }}>
      {[0, 1, 2, 3].map((i) => (
        <motion.span
          key={i}
          className="rounded-full bg-current"
          style={{ width: bar, height: size, originY: 1 }}
          animate={reduce ? { opacity: [0.4, 1, 0.4] } : { scaleY: [0.3, 1, 0.3] }}
          transition={{
            duration: speed,
            ease: EASE_IN_OUT,
            repeat: Number.POSITIVE_INFINITY,
            delay: i * speed * 0.12,
          }}
        />
      ))}
    </span>
  );
}

function DotMatrix({ size, speed, reduce }: PartProps) {
  const n = 3;
  const gap = size * 0.14;
  const dot = (size - gap * (n - 1)) / n;
  const cells = Array.from({ length: n * n }, (_, idx) => idx);
  return (
    <span
      className="grid"
      style={{ gap, gridTemplateColumns: `repeat(${n}, ${dot}px)` }}
    >
      {cells.map((idx) => {
        const x = idx % n;
        const y = Math.floor(idx / n);
        // Diagonal wave: cells light in order of their distance from the corner.
        const delay = ((x + y) / (2 * (n - 1))) * speed;
        return (
          <motion.span
            key={idx}
            className="rounded-full bg-current"
            style={{ width: dot, height: dot }}
            animate={
              reduce
                ? { opacity: [0.3, 1, 0.3] }
                : { opacity: [0.2, 1, 0.2], scale: [0.7, 1, 0.7] }
            }
            transition={{
              duration: speed,
              ease: EASE_IN_OUT,
              repeat: Number.POSITIVE_INFINITY,
              delay,
            }}
          />
        );
      })}
    </span>
  );
}

const COMET_TRAIL = [0, 1, 2, 3, 4, 5];

function Comet({ size, speed, reduce }: PartProps) {
  const head = size * 0.2;
  const r = size / 2 - head / 2;
  return (
    <span className="relative" style={{ width: size, height: size }}>
      <motion.span
        className="absolute inset-0"
        animate={reduce ? REDUCED.animate : { rotate: 360 }}
        transition={
          reduce
            ? REDUCED.transition
            : { duration: speed, ease: "linear", repeat: Number.POSITIVE_INFINITY }
        }
      >
        {COMET_TRAIL.map((i) => {
          const scale = 1 - i * 0.13;
          const sz = head * scale;
          return (
            <span
              key={i}
              className="absolute left-1/2 top-1/2 rounded-full bg-current"
              style={{
                width: sz,
                height: sz,
                marginLeft: -sz / 2,
                marginTop: -sz / 2,
                opacity: 1 - i * 0.16,
                transform: `rotate(${-i * 15}deg) translateY(${-r}px)`,
              }}
            />
          );
        })}
      </motion.span>
    </span>
  );
}

function Helix({ size, speed, reduce }: PartProps) {
  const rows = 7;
  const dot = size * 0.14;
  const amp = size * 0.32;
  return (
    <span className="relative" style={{ width: size, height: size }}>
      {Array.from({ length: rows }, (_, r) => {
        const top = (r / (rows - 1)) * (size - dot);
        const delay = (r / rows) * speed;
        return (
          <span key={`row-${top}`}>
            <motion.span
              className="absolute rounded-full bg-current"
              style={{ width: dot, height: dot, left: size / 2 - dot / 2, top }}
              animate={
                reduce
                  ? { opacity: [0.4, 1, 0.4] }
                  : { x: [amp, -amp, amp], scale: [1, 0.5, 1], opacity: [1, 0.45, 1] }
              }
              transition={{
                duration: speed,
                ease: EASE_IN_OUT,
                repeat: Number.POSITIVE_INFINITY,
                delay,
              }}
            />
            <motion.span
              className="absolute rounded-full bg-current"
              style={{ width: dot, height: dot, left: size / 2 - dot / 2, top }}
              animate={
                reduce
                  ? { opacity: [0.4, 1, 0.4] }
                  : { x: [-amp, amp, -amp], scale: [0.5, 1, 0.5], opacity: [0.45, 1, 0.45] }
              }
              transition={{
                duration: speed,
                ease: EASE_IN_OUT,
                repeat: Number.POSITIVE_INFINITY,
                delay,
              }}
            />
          </span>
        );
      })}
    </span>
  );
}

function Ascii({ size, speed, reduce }: PartProps) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    // Reduced motion slows the cycle rather than stopping it - it's a glyph
    // swap, not on-screen movement.
    const step = ((reduce ? speed * 2.5 : speed) / ASCII_FRAMES.length) * 1000;
    const id = setInterval(() => setFrame((f) => (f + 1) % ASCII_FRAMES.length), step);
    return () => clearInterval(id);
  }, [speed, reduce]);

  return (
    <span
      className="font-mono leading-none tabular-nums"
      style={{ fontSize: size, lineHeight: 1 }}
    >
      {ASCII_FRAMES[frame % ASCII_FRAMES.length]}
    </span>
  );
}

// -- agent status card -----------------------------------------------------
export type AgentPhaseKind = "thinking" | "searching" | "running" | "done";

export interface AgentPhase {
  id: string;
  kind: AgentPhaseKind;
  label: ReactNode;
}

const PHASE_VARIANT: Record<AgentPhaseKind, LoaderVariant> = {
  thinking: "dots",
  searching: "comet",
  running: "bars",
  done: "spinner",
};

// Rolling label swap - the phase text slides up and blurs out as it changes.
const ROLL_TEXT_VARIANTS: Variants = {
  initial: { opacity: 0, y: "70%", filter: "blur(3px)" },
  animate: { opacity: 1, y: "0%", filter: "blur(0px)", transition: SPRING_SWAP },
  exit: {
    opacity: 0,
    y: "-70%",
    filter: "blur(3px)",
    transition: { duration: 0.14, ease: EASE_OUT },
  },
};

/** Compact agent working indicator: a loader (or a settled check) paired with a
 * rolling phase label. Feed it a `phase`; set `done` when the work has finished. */
export function AgentStatusIndicator({
  phase,
  done = false,
  className,
}: {
  phase: AgentPhase;
  done?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const settled = done || phase.kind === "done";
  const labelKey = typeof phase.label === "string" ? phase.label : phase.id;

  return (
    <div
      data-state={settled ? "done" : "working"}
      aria-busy={!settled}
      className={cx(
        "inline-flex w-full items-center gap-3 rounded-2xl border border-border-button-default bg-background-primary-default px-3.5 py-2.5 text-body-2-regular shadow-sm",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "grid size-8 shrink-0 place-items-center rounded-xl bg-background-secondary-default transition-colors",
          settled ? "text-lime-600" : "text-accent-500",
        )}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {settled ? (
            <motion.span
              key="done"
              initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
              transition={reduce ? { duration: 0 } : SPRING_SWAP}
              className="grid place-items-center"
            >
              <RiCheckLine className="size-[18px]" />
            </motion.span>
          ) : (
            <motion.span
              key={phase.kind}
              initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
              transition={reduce ? { duration: 0 } : SPRING_SWAP}
              className="grid place-items-center"
            >
              <Loader variant={PHASE_VARIANT[phase.kind]} size={18} label="Working" />
            </motion.span>
          )}
        </AnimatePresence>
      </span>

      <span className="relative min-w-0 flex-1 overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={labelKey}
            variants={reduce ? undefined : ROLL_TEXT_VARIANTS}
            initial={reduce ? false : "initial"}
            animate={reduce ? { opacity: 1 } : "animate"}
            exit={reduce ? { opacity: 0 } : "exit"}
            className={cx(
              "block truncate text-body-2-medium will-change-[opacity,filter,transform]",
              settled ? "text-text-primary" : "text-text-secondary",
            )}
          >
            {phase.label}
          </motion.span>
        </AnimatePresence>
      </span>

      <span className="shrink-0 font-mono text-[11px] text-text-tertiary">
        {settled ? "done" : phase.kind}
      </span>
    </div>
  );
}

const DEMO_PHASES: AgentPhase[] = [
  { id: "think", kind: "thinking", label: "Thinking through the request" },
  { id: "search", kind: "searching", label: "Searching the codebase" },
  { id: "run", kind: "running", label: "Running the build" },
  { id: "done", kind: "done", label: "Finished the task" },
];

const STEP_MS = 1900;

/** Self-driving demo: walks an agent from thinking to done, then loops. */
export function AgentLoaderDemo() {
  const [step, setStep] = useState(0);
  const uid = useId();

  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % DEMO_PHASES.length), STEP_MS);
    return () => clearInterval(id);
  }, []);

  const phase = DEMO_PHASES[step];
  const gallery: LoaderVariant[] = ["spinner", "dots", "bars", "dot-matrix", "comet", "helix"];

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="flex w-full max-w-md flex-col gap-3">
        <AgentStatusIndicator phase={phase} done={phase.kind === "done"} />
        <div className="grid grid-cols-3 gap-2">
          {gallery.map((variant) => (
            <div
              key={`${uid}-${variant}`}
              className="flex flex-col items-center gap-2 rounded-xl border border-border-button-default bg-background-primary-default p-3 text-text-primary"
            >
              <div className="flex h-7 items-center justify-center">
                <Loader variant={variant} size={22} />
              </div>
              <span className="font-mono text-[10px] text-text-tertiary">{variant}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default AgentLoaderDemo;
