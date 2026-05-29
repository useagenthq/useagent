import { cx as cn } from "@/utils/cx";

/**
 * Pixel-matrix loading state — a 5×5 grid pulsing on a diagonal stagger
 * (`.ai-loading-pixel`) over a shimmer label (`.agent-progress-loading-text`).
 * Used as the session route's fetch fallback (app/session/(thread)/[id]/loading.tsx (historical note: now the content-area skeleton)).
 */
export function LoadingState({
  label = "Loading session",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-5", className)}>
      <div className="grid grid-cols-5 gap-1.5" aria-hidden>
        {Array.from({ length: 25 }).map((_, i) => {
          const row = Math.floor(i / 5);
          const col = i % 5;
          return (
            <span
              key={i}
              className="ai-loading-pixel bg-accent-500 size-2 rounded-[3px]"
              style={{ animationDelay: `${(row + col) * 90}ms` }}
            />
          );
        })}
      </div>
      <span className="agent-progress-loading-text text-body-2-medium">{label}</span>
    </div>
  );
}
