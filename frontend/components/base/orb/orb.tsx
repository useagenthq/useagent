import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cx } from "@/utils/cx";

/** The theme's state ramp; a tone is always a semantic variable, never a raw color. */
export const ORB_TONES = [
  "primary",
  "feature",
  "success",
  "warning",
  "error",
  "verified",
  "highlighted",
  "away",
] as const;
export type OrbTone = (typeof ORB_TONES)[number];

/** `solid` is one tone; `prism` is the iridescent sweep with a dark ring. */
export type OrbVariant = "solid" | "prism";

/** Diameter behind each size class, so the gloss and glow scale with the ball. */
const PX: Record<string, number> = {
  "size-5": 20,
  "size-6": 24,
  "size-8": 32,
  "size-10": 40,
  "size-14": 56,
  "size-16": 64,
};

export interface OrbProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: OrbTone;
  variant?: OrbVariant;
  /** A Tailwind size class (`size-5` ... `size-16`). */
  size?: string;
  children?: ReactNode;
}

/**
 * A glossy sphere: a bright highlight cap top-left, the tone deepening toward
 * the bottom edge, a thin darker rim and a faint glow in its own color. One
 * element, layered backgrounds; the recipe is `.orb` in app/globals.css and
 * reads the `--orb-tone` set here. Children (a glyph, a state dot) sit centered
 * over it. No motion, so nothing to reduce.
 */
export function Orb({
  tone = "primary",
  variant = "solid",
  size = "size-10",
  children,
  className,
  style,
  ...rest
}: OrbProps) {
  const vars = { "--orb-tone": `hsl(var(--${tone}-base))`, "--orb-px": PX[size] ?? 40 } as CSSProperties;
  return (
    <span
      className={cx("orb relative inline-flex shrink-0 items-center justify-center rounded-full", size, className)}
      style={{ ...vars, ...style }}
      data-variant={variant}
      {...rest}
    >
      {children}
    </span>
  );
}
