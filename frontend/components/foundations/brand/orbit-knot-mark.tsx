import { cn } from "@/utils/cn";

/**
 * Skynet orbit-knot mark: a single-stroke rounded {7/2} star knot - seven
 * petals woven from one continuous line, matching the product reference.
 * Brand layer exception: the light-cyan to blue ramp is part of the mark and
 * is the one place a raw color ramp is allowed. Size via className; the knot
 * spins slowly while `active` (reduced-motion safe via motion-safe).
 */
export function OrbitKnotMark({
  className,
  active = false,
}: {
  className?: string;
  active?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn(
        "shrink-0",
        active && "motion-safe:animate-[spin_9s_linear_infinite]",
        className,
      )}
    >
      <defs>
        <linearGradient
          id="orbit-knot-ramp"
          x1="5"
          y1="4"
          x2="19"
          y2="20"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#8be0fc" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      <path
        d="M 8.23 7.52 Q 12.00 2.80 15.77 7.52 L 17.20 9.32 Q 20.97 14.05 15.53 16.67 L 13.45 17.67 Q 8.01 20.29 6.66 14.40 L 6.15 12.15 Q 4.81 6.26 10.85 6.26 L 13.15 6.26 Q 19.19 6.26 17.85 12.15 L 17.34 14.40 Q 15.99 20.29 10.55 17.67 L 8.47 16.67 Q 3.03 14.05 6.80 9.32 L 8.23 7.52 Z"
        stroke="url(#orbit-knot-ramp)"
        strokeWidth="1.9"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
