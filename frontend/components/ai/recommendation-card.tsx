import type { ReactNode } from "react";
import * as Badge from "@/components/ui/badge";
import * as Button from "@/components/ui/button";
import { cx } from "@/utils/cx";

/**
 * Suggestion card — a titled recommendation with a confidence pill and an
 * Accept / Alternatives footer. Ported from the AI library's RecommendationCard
 * onto AlignUI tokens (Badge + Button).
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
  { color: "green" | "yellow" | "gray"; dot: string; label: string }
> = {
  high: {
    color: "green",
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
        <Badge.Root variant="light" color={meta.color} size="medium">
          <span className={cx("size-1.5 rounded-full", meta.dot)} aria-hidden />
          {meta.label}
        </Badge.Root>
        <div className="flex items-center gap-2">
          {onAlternatives && (
            <Button.Root className="rounded-full"
              variant="neutral"
              mode="ghost"
              size="small"
              onClick={onAlternatives}
            >
              Alternatives
            </Button.Root>
          )}
          <Button.Root className="rounded-full" variant="primary" mode="filled" size="small" onClick={onAccept}>
            Accept
          </Button.Root>
        </div>
      </div>
    </article>
  );
}
