import type { ReactNode } from "react";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";

/**
 * Suggestion card - a titled recommendation with a confidence meter and an
 * Accept / Alternatives footer. Composed from our Button primitive and tokens.
 *
 * Confidence renders as a 3-bar signal meter (high = 3 filled, medium = 2, low
 * = 1) beside a label.
 *
 * Handlers are passed in by the (client) consumer; this component owns no
 * state, so it stays a plain composable leaf.
 */

type Confidence = "high" | "medium" | "low";

const confidenceMeta: Record<Confidence, { bars: number; fill: string; label: string }> = {
  high: { bars: 3, fill: "bg-lime-500", label: "High confidence" },
  medium: { bars: 2, fill: "bg-orange-500", label: "Medium confidence" },
  low: { bars: 1, fill: "bg-foreground-icon-tertiary", label: "Low confidence" },
};

export interface RecommendationCardProps {
  title: string;
  body: ReactNode;
  confidence: Confidence;
  onAccept: () => void;
  onAlternatives?: () => void;
  className?: string;
}

export function RecommendationCard({
  title,
  body,
  confidence,
  onAccept,
  onAlternatives,
  className,
}: RecommendationCardProps) {
  const meta = confidenceMeta[confidence];
  return (
    <article
      className={cx(
        "overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-card",
        className,
      )}
    >
      <div className="flex flex-col gap-1.5 p-4">
        <h3 className="text-body-medium text-text-primary">{title}</h3>
        <div className="min-h-12 text-body-2-regular leading-relaxed text-text-secondary">{body}</div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border-button-default bg-background-secondary-default px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="flex items-end gap-0.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={cx(
                  "w-1 rounded-full",
                  i === 0 ? "h-2" : i === 1 ? "h-2.5" : "h-3",
                  i < meta.bars ? meta.fill : "bg-border-button-hover",
                )}
              />
            ))}
          </span>
          <span className="text-caption-1-medium text-text-secondary">{meta.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {onAlternatives && (
            <Button
              className="rounded-full"
              variant="ghost"
              size="small"
              onClick={onAlternatives}
            >
              Alternatives
            </Button>
          )}
          <Button className="rounded-full" variant="primary" size="small" onClick={onAccept}>
            Accept
          </Button>
        </div>
      </div>
    </article>
  );
}
