import type { ReactNode } from "react";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";

/**
 * Suggestion card — a titled recommendation with a confidence pill and an
 * Accept / Alternatives footer. Ported from the AI library's RecommendationCard
 * onto our tokens (Badge + Button).
 *
 * The confidence Badge pairs a colored dot with a label:
 *   high → green · medium → yellow · low → gray.
 *
 * Handlers are passed in by the (client) consumer; this component owns no
 * state, so it stays a plain composable leaf.
 */

type Confidence = "high" | "medium" | "low";

const confidenceMeta: Record<
  Confidence,
  { color: "lime" | "yellow" | "gray"; dot: string; label: string }
> = {
  high: {
    color: "lime",
    dot: "bg-lime-500",
    label: "High confidence",
  },
  medium: {
    color: "yellow",
    dot: "bg-orange-500",
    label: "Medium confidence",
  },
  low: {
    color: "gray",
    dot: "bg-foreground-icon-tertiary",
    label: "Low confidence",
  },
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
        <div className="text-body-2-regular text-text-secondary">{body}</div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border-button-default bg-background-secondary-default px-4 py-3">
        <Chip color={meta.color}>
          <span className={cx("size-1.5 rounded-full", meta.dot)} aria-hidden />
          {meta.label}
        </Chip>
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
