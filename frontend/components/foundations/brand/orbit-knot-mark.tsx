"use client";

import { useId } from "react";
import { cn } from "@/utils/cn";

// Exact continuous path from the user-supplied star-knot.svg reference.
const KNOT_PATH =
  "M 150.00 51.00 C 176.40 51.00, 176.40 67.72, 201.42 88.72 C 226.45 109.71, 242.91 106.81, 247.50 132.81 C 252.08 158.80, 235.62 161.71, 219.28 190.00 C 202.95 218.29, 208.67 234.00, 183.86 243.03 C 159.05 252.06, 153.33 236.35, 122.64 225.18 C 91.94 214.00, 77.46 222.36, 64.26 199.50 C 51.06 176.64, 65.54 168.28, 71.22 136.11 C 76.89 103.94, 66.14 91.13, 86.36 74.16 C 106.59 57.19, 117.33 70.00, 150.00 70.00 C 182.67 70.00, 193.41 57.19, 213.64 74.16 C 233.86 91.13, 223.11 103.94, 228.78 136.11 C 234.46 168.28, 248.94 176.64, 235.74 199.50 C 222.54 222.36, 208.06 214.00, 177.36 225.18 C 146.67 236.35, 140.95 252.06, 116.14 243.03 C 91.33 234.00, 97.05 218.29, 80.72 190.00 C 64.38 161.71, 47.92 158.80, 52.50 132.81 C 57.09 106.81, 73.55 109.71, 98.58 88.72 C 123.60 67.72, 123.60 51.00, 150.00 51.00 Z";

function KnotSvg({
  className,
  stroke,
  gradientId,
}: {
  className?: string;
  stroke: number;
  gradientId: string;
}) {
  return (
    <svg viewBox="0 0 300 300" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1="0"
          x2="300"
          y2="300"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#6DD5FA" />
          <stop offset="0.45" stopColor="#55B9F3" />
          <stop offset="1" stopColor="#20A9F5" />
        </linearGradient>
      </defs>
      <path
        d={KNOT_PATH}
        stroke={`url(#${gradientId})`}
        strokeWidth={stroke * 4}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * UseAgent star-knot mark. Geometry is the exact user-supplied continuous path;
 * size and color remain controlled by the caller's design-token classes.
 * `stroke` retains the existing compact component scale (the reference's 6-unit
 * stroke is the default 1.5 multiplied into its 300-unit viewBox).
 *
 * While `active` the mark spins slowly and breathes a soft glow. Both effects
 * remain motion-safe, and the crisp glyph itself never fades.
 */
export function OrbitKnotMark({
  className,
  active = false,
  stroke = 1.5,
}: {
  className?: string;
  active?: boolean;
  stroke?: number;
}) {
  const gradientId = useId();
  const glowGradientId = useId();
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      {active ? (
        <KnotSvg
          stroke={stroke + 1.5}
          gradientId={glowGradientId}
          className="absolute inset-0 size-full blur-[5px] motion-safe:animate-pulse motion-reduce:opacity-60"
        />
      ) : null}
      <KnotSvg
        stroke={stroke}
        gradientId={gradientId}
        className={cn(
          "relative size-full",
          active && "motion-safe:animate-[spin_9s_linear_infinite]",
        )}
      />
    </span>
  );
}
