import { cx as cnExt } from "@/utils/cx";

/**
 * A bare 12×12 status disc — the vendored kit ships StatusBadge.Dot only inside a badge,
 * so this is the standalone dot the agent surfaces (fleet lanes, schedules,
 * recent tasks, live chip) share. `hollow` renders an outlined ring (queued);
 * `pulse` gently breathes for live/running states.
 */
export type DotTone = "success" | "away" | "error" | "info" | "neutral";

const TONE_FILL: Record<DotTone, string> = {
  success: "bg-lime-500",
  away: "bg-orange-500",
  error: "bg-red-500",
  info: "bg-blue-500",
  neutral: "bg-text-tertiary",
};

const TONE_RING: Record<DotTone, string> = {
  success: "border-lime-500",
  away: "border-orange-500",
  error: "border-border-error-default",
  info: "border-blue-500",
  neutral: "border-border-button-hover",
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
