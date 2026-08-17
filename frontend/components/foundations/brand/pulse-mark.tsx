import { cn } from "@/utils/cn";

/** Cyan orbit mark derived from the Skynet visual reference. Three intersecting
 * ellipses form the six-lobed glyph; the group rotates only while work is live.
 * Color and size remain caller-owned through currentColor and className. */
export function PulseMark({ className, active = false }: { className?: string; active?: boolean }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: presentational brand glyph is hidden from assistive technology
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={cn("size-6", className)}>
      <g className={cn(active && "skynet-orbit-active")}>
        <ellipse cx="12" cy="12" rx="4.7" ry="9.1" stroke="currentColor" strokeWidth="1.55" />
        <ellipse
          cx="12"
          cy="12"
          rx="4.7"
          ry="9.1"
          stroke="currentColor"
          strokeWidth="1.55"
          transform="rotate(60 12 12)"
        />
        <ellipse
          cx="12"
          cy="12"
          rx="4.7"
          ry="9.1"
          stroke="currentColor"
          strokeWidth="1.55"
          transform="rotate(120 12 12)"
        />
      </g>
    </svg>
  );
}
