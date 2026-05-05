"use client";

import { useEffect, useState } from "react";
import { motion, MotionConfig, useAnimationControls, useReducedMotion } from "motion/react";
import { cnExt } from "@/utils/cn";

/**
 * NumberTicker — a lean inline rolling-digits value for dashboard stats
 * (ported from the skynet-saas reference, pill chrome dropped). Each digit is
 * an odometer <Reel>; non-digit characters (separators, a compact "M"/"K"
 * suffix) render statically so "1.2M" or "12,480" tick correctly. Rolls up on
 * mount and whenever `value` changes; honours prefers-reduced-motion.
 */
export function NumberTicker({
  value,
  format,
  play = true,
  className,
}: {
  value: number;
  /** Turn the number into its display string (e.g. compact "1.2M"). */
  format?: (value: number) => string;
  /** Set false to freeze on the current value with no run-up. */
  play?: boolean;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const text = format ? format(value) : String(value);
  const [runKey, setRunKey] = useState(1);
  useEffect(() => {
    if (!play) return;
    setRunKey((key) => key + 1);
  }, [value, play]);

  let digitIndex = -1;
  return (
    <MotionConfig reducedMotion="user">
      <span
        className={cnExt("inline-flex items-baseline tabular-nums leading-none", className)}
        aria-label={text}
      >
        {Array.from(text).map((char, position) => {
          if (/\d/.test(char)) {
            digitIndex += 1;
            const index = digitIndex;
            return (
              <Reel
                key={`d${index}`}
                digit={Number(char)}
                index={index}
                runKey={reduced || !play ? 0 : runKey}
              />
            );
          }
          return (
            <span key={`s${position}`} aria-hidden="true" className="whitespace-pre">
              {char}
            </span>
          );
        })}
      </span>
    </MotionConfig>
  );
}

const EASE = [0.22, 1, 0.36, 1] as const;
const REEL_FIGURES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

// One odometer column. Two 0-9 cycles stacked (20 figures); the strip rests on
// `10 + digit`. A runKey bump snaps it to 0 then releases it to the target so it
// scrolls a full turn before landing — the "run up", cascading left→right.
function Reel({ digit, index, runKey }: { digit: number; index: number; runKey: number }) {
  const reduced = useReducedMotion();
  const controls = useAnimationControls();
  const target = `${-(10 + digit)}em`;

  useEffect(() => {
    if (runKey <= 0 || reduced) return;
    controls.set({ y: "0em" });
    controls.start({ y: target, transition: { duration: 0.64, ease: EASE, delay: index * 0.055 } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  return (
    <motion.span
      className="relative h-[1em] w-[1ch] overflow-hidden text-center"
      aria-hidden="true"
      initial={{ opacity: 0, filter: "blur(2px)" }}
      animate={{ opacity: 1, filter: "blur(0px)" }}
      transition={{ duration: 0.17, ease: EASE }}
    >
      <motion.span className="flex flex-col" style={{ y: target }} animate={controls}>
        {REEL_FIGURES.map((n, i) => (
          <span className="h-[1em] leading-[1em]" key={i}>
            {n}
          </span>
        ))}
      </motion.span>
    </motion.span>
  );
}
