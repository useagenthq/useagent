import { cn } from "@/utils/cn";

/**
 * Skynet orbit-knot mark: a single-stroke {7/2} star knot (T3-style weave).
 * Brand layer exception: the blue gradient is part of the mark itself and is
 * the one place a raw color ramp is allowed. Size via className; the knot
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
        <linearGradient id="orbit-knot-ramp" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7dd3fc" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      <path
        d="M12 3 L20.77 14 L8.09 20.11 L4.97 6.39 L19.03 6.39 L15.91 20.11 L3.23 14 Z"
        stroke="url(#orbit-knot-ramp)"
        strokeWidth="2.1"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
