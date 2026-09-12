import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "@/utils/cx";

/**
 * The orb palette. These are identity colors, not state colors: a bot's ball
 * is the same vivid hue in every theme (the state ramp goes pastel in the dark
 * themes and turned the balls chalky). The pairs live in app/globals.css under
 * `.orb[data-tone]`, never in a component.
 */
export const ORB_TONES = ["blue", "violet", "rose", "emerald", "amber", "cyan", "fuchsia", "slate"] as const;
export type OrbTone = (typeof ORB_TONES)[number];

/** `solid` is one tone; `prism` is the iridescent sweep with a dark ring. */
export type OrbVariant = "solid" | "prism";

/** Tones whose center is bright enough that white ink fails 3:1; they take black. */
export const ORB_DARK_INK: ReadonlySet<OrbTone> = new Set<OrbTone>(["emerald", "amber", "cyan"]);

export interface OrbProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: OrbTone;
  variant?: OrbVariant;
  /** A Tailwind size class (`size-5` ... `size-16`). */
  size?: string;
  children?: ReactNode;
}

const SHEEN = ["glaze", "cap", "glint", "bounce"] as const;

/**
 * A glossy sphere built the way the reference swatches are: a radial base
 * from a lighter center to a deeper edge, then four white sheen layers inside
 * a clipped ball (a bottom glaze, a wide top cap, a small glint, and the
 * bounce light along the bottom). No shadow, no glow, no motion. Children
 * (a glyph, a state dot) sit above the ball and are not clipped, so a state
 * dot can still ride the edge. The recipe is `.orb` in app/globals.css.
 */
export function Orb({
  tone = "blue",
  variant = "solid",
  size = "size-10",
  children,
  className,
  ...rest
}: OrbProps) {
  const ink = variant === "prism" || ORB_DARK_INK.has(tone) ? "dark" : "light";
  return (
    <span
      className={cx("orb relative inline-flex shrink-0 items-center justify-center rounded-full", size, className)}
      data-tone={variant === "prism" ? undefined : tone}
      data-variant={variant}
      data-ink={ink}
      {...rest}
    >
      <span className="orb-ball absolute inset-0 overflow-hidden rounded-full" aria-hidden>
        {SHEEN.map((layer) => (
          <span key={layer} className="orb-sheen" data-layer={layer} />
        ))}
      </span>
      {children}
    </span>
  );
}
