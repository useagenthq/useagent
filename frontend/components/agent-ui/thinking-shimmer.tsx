// Ported from beui.dev registry "loading-states" (components/agents/ThinkingShimmer.tsx +
// the TextShimmer primitive and lib/text-shimmer inlined). Re-expressed with our AlignUI
// tokens. A shimmering "thinking" text placeholder: a soft-to-strong gradient sweeps across
// the label while the agent works.
"use client";

import { useReducedMotion } from "motion/react";
import { type CSSProperties, type ElementType, type ReactNode, useEffect, useState } from "react";

import { cx } from "@/utils/cx";

// The keyframe sweeps the gradient across the clipped text. Scoped name so it never
// collides with the global `.agent-progress-loading-text` shimmer.
const SHIMMER_KEYFRAMES =
  "@keyframes agent-thinking-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}";

// Soft -> strong -> soft, so the bright band reads as light passing over the label.
const SHIMMER_CLASS_NAME =
  "bg-[length:200%_100%] bg-clip-text text-transparent bg-[linear-gradient(110deg,var(--color-text-tertiary)_30%,var(--color-text-primary)_50%,var(--color-text-tertiary)_70%)]";

interface TextShimmerProps {
  children: ReactNode;
  as?: ElementType;
  /** Seconds taken for one shimmer pass. */
  duration?: number;
  className?: string;
}

/** Text with a gradient sweep clipped to the glyphs. Reusable primitive - wrap any label. */
export function TextShimmer({ children, as: Comp = "span", duration = 2.5, className }: TextShimmerProps) {
  const reduce = useReducedMotion() ?? false;
  const style: CSSProperties = reduce
    ? {}
    : { animation: `agent-thinking-shimmer ${duration}s linear infinite` };

  return (
    <>
      <style>{SHIMMER_KEYFRAMES}</style>
      <Comp
        style={style}
        className={cx(
          "inline-block",
          reduce ? "text-text-secondary" : SHIMMER_CLASS_NAME,
          className,
        )}
      >
        {children}
      </Comp>
    </>
  );
}

/** A single "thinking" line: the shimmering label used while an agent step runs. */
export function ShimmerLabel({
  children = "Thinking...",
  duration = 1.8,
  className,
}: {
  children?: ReactNode;
  duration?: number;
  className?: string;
}) {
  return (
    <TextShimmer as="span" duration={duration} className={cx("text-body-2-medium font-medium", className)}>
      {children}
    </TextShimmer>
  );
}

const DEMO_STEPS: { label: string; duration: number }[] = [
  { label: "Thinking...", duration: 1.8 },
  { label: "Reading the context...", duration: 1.2 },
  { label: "Searching 12 sources...", duration: 2.6 },
  { label: "Drafting a response...", duration: 1.5 },
];

const STEP_MS = 1600;

/** Self-driving demo: cycles through a few thinking lines, one at a time, then loops. */
export function ThinkingShimmerDemo() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % DEMO_STEPS.length), STEP_MS);
    return () => clearInterval(id);
  }, []);

  const current = DEMO_STEPS[step];

  return (
    <div className="flex items-center justify-center rounded-xl bg-background-secondary-default p-3">
      <div className="flex w-full max-w-md items-center gap-2 rounded-2xl border border-border-button-default bg-background-primary-default px-3.5 py-3 shadow-sm">
        <span aria-hidden="true" className="flex shrink-0 items-center gap-1">
          <span className="size-1.5 animate-pulse rounded-full bg-foreground-icon-tertiary [animation-delay:0ms]" />
          <span className="size-1.5 animate-pulse rounded-full bg-foreground-icon-tertiary [animation-delay:200ms]" />
          <span className="size-1.5 animate-pulse rounded-full bg-foreground-icon-tertiary [animation-delay:400ms]" />
        </span>
        <ShimmerLabel key={step} duration={current.duration}>
          {current.label}
        </ShimmerLabel>
      </div>
    </div>
  );
}

export default ThinkingShimmerDemo;
