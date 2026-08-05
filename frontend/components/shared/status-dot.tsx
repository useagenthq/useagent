import { cnExt } from "@/utils/cn";

/**
 * A bare 12×12 status disc — AlignUI ships StatusBadge.Dot only inside a badge,
 * so this is the standalone dot the agent surfaces (fleet lanes, schedules,
 * recent tasks, live chip) share. `hollow` renders an outlined ring (queued);
 * `pulse` gently breathes for live/running states.
 */
export type DotTone = "success" | "away" | "error" | "info" | "neutral";

const TONE_FILL: Record<DotTone, string> = {
  success: "bg-success-base",
  away: "bg-away-base",
  error: "bg-error-base",
  info: "bg-information-base",
  neutral: "bg-text-soft-400",
};

const TONE_RING: Record<DotTone, string> = {
  success: "border-success-base",
  away: "border-away-base",
  error: "border-error-base",
  info: "border-information-base",
  neutral: "border-stroke-sub-300",
};

export function StatusDot({
  tone = "neutral",
  hollow = false,
  pulse = false,
  className,
}: {
  tone?: DotTone;
  hollow?: boolean;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cnExt("inline-flex size-3 shrink-0 items-center justify-center", className)}
    >
      <span
        className={cnExt(
          "size-1.5 rounded-full",
          hollow ? cnExt("border", TONE_RING[tone]) : TONE_FILL[tone],
          pulse && "animate-pulse",
        )}
      />
    </span>
  );
}
