import { cn } from "@/utils/cn";

/** useAgent's six-lobed orbit. The narrow stroke and compact ellipse geometry are
 * traced from the product reference instead of using a generic atom icon. */
export function PulseMark({ className, active = false }: { className?: string; active?: boolean }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: presentational brand glyph is hidden from assistive technology
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={cn("size-6", className)}>
      <g className={cn(active && "useagent-orbit-active")}>
        <ellipse
          cx="12"
          cy="12"
          rx="4.7"
          ry="9.1"
          stroke="currentColor"
          strokeWidth="0.85"
          strokeLinecap="round"
        />
        <ellipse
          cx="12"
          cy="12"
          rx="4.7"
          ry="9.1"
          stroke="currentColor"
          strokeWidth="0.85"
          strokeLinecap="round"
          transform="rotate(60 12 12)"
        />
        <ellipse
          cx="12"
          cy="12"
          rx="4.7"
          ry="9.1"
          stroke="currentColor"
          strokeWidth="0.85"
          strokeLinecap="round"
          transform="rotate(120 12 12)"
        />
      </g>
    </svg>
  );
}
