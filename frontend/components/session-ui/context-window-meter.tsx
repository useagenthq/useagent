"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Sources:
//   apps/web/src/components/chat/ContextWindowMeter.tsx (the slim ring meter +
//     hover detail panel: percent, used/max, total processed, auto-compaction note)
//   apps/web/src/lib/contextWindow.ts (formatContextWindowTokens; the snapshot
//     shape reduced to the fields this meter renders)
//
// Port notes:
// - Upstream takes a ContextWindowSnapshot derived from context-window.updated
//   thread activities; our backend emits no such event, so ContextWindowUsage
//   is the minimal prop shape and the percentage is computed HERE from
//   usedTokens/maxTokens (no caller math). Bind real data via
//   contextWindowFromChildUsage in ./adapter.ts.
// - Their hover Popover (tooltipStyle) -> BoardUI tooltip (react-aria; the
//   plain button trigger is wrapped in Focusable); the detail panel is
//   the exported ContextWindowDetails so it stays SSR-testable and reusable.
// - CSS color-mix ring colors -> semantic token classes with currentColor
//   strokes (track text-background-tertiary-default, fill text-text-tertiary, >90% overloaded
//   -> text-text-error-primary).

import { Focusable } from "react-aria-components";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { cx as cn } from "@/utils/cx";

/** The minimal usage shape the meter renders; maxTokens null = unknown limit. */
export interface ContextWindowUsage {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly totalProcessedTokens?: number | null;
  readonly compactsAutomatically?: boolean;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** Percent of the window used, or null when the limit is unknown. */
export function contextWindowUsedPercentage(usage: ContextWindowUsage): number | null {
  if (usage.maxTokens === null || usage.maxTokens <= 0) return null;
  return Math.min(100, (usage.usedTokens / usage.maxTokens) * 100);
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

/** The meter's detail panel (upstream's popover body), SSR-renderable on its own. */
export function ContextWindowDetails(props: {
  usage: ContextWindowUsage;
  providerDisplayName?: string | null;
}) {
  const { usage, providerDisplayName } = props;
  const usedPercentage = contextWindowUsedPercentage(usage);
  const usedPercentageLabel = formatPercentage(usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usedPercentage ?? 0));
  const isOverloaded = normalizedPercentage > 90;
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;

  return (
    <div data-session-ui="context-window-details" className="flex w-64 flex-col gap-2 text-left">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] font-medium text-text-secondary">Context Window</div>
        {usage.maxTokens !== null && usedPercentageLabel ? (
          <div className="text-[11px] text-text-tertiary tabular-nums">
            <span>{usedPercentageLabel}</span>
            <span className="mx-1">·</span>
            <span>
              {formatContextWindowTokens(usage.usedTokens)}/
              {formatContextWindowTokens(usage.maxTokens)}
            </span>
          </div>
        ) : (
          <div className="text-[11px] text-text-tertiary tabular-nums">
            {formatContextWindowTokens(usage.usedTokens)}
          </div>
        )}
      </div>
      {usage.maxTokens !== null ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-background-tertiary-default"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(normalizedPercentage)}
          aria-label="Context window usage"
        >
          <div
            className={cn(
              "h-full rounded-full bg-foreground-icon-tertiary transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
              isOverloaded && "bg-red-500",
            )}
            style={{ width: `${normalizedPercentage}%` }}
          />
        </div>
      ) : null}
      {showTotalProcessed ? (
        <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
          <span className="text-text-tertiary">Total processed</span>
          <span className="font-medium text-text-tertiary tabular-nums">
            {formatContextWindowTokens(totalProcessedTokens)}
          </span>
        </div>
      ) : null}
      {usage.compactsAutomatically ? (
        <div className="mt-1 text-pretty text-[11px] font-medium text-text-tertiary">
          {providerDisplayName ?? "It"} automatically compacts its context when needed.
        </div>
      ) : null}
    </div>
  );
}

/**
 * The slim context-window ring: fills with usage, turns error-red past 90%,
 * and reveals ContextWindowDetails on hover. Purely presentational.
 */
export function ContextWindowMeter(props: {
  usage: ContextWindowUsage;
  providerDisplayName?: string | null;
}) {
  const { usage, providerDisplayName } = props;
  const usedPercentage = contextWindowUsedPercentage(usage);
  const usedPercentageLabel = formatPercentage(usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const isOverloaded = normalizedPercentage > 90;

  return (
    <TooltipTrigger delay={150}>
      <Focusable>
        <button
          type="button"
          data-session-ui="context-window-meter"
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full border border-transparent text-text-secondary outline-none transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          aria-label={
            usage.maxTokens !== null && usedPercentageLabel
              ? `Context window ${usedPercentageLabel} used`
              : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
          }
        >
          <span className="relative flex size-5 items-center justify-center">
            <svg
              viewBox="0 0 24 24"
              className="absolute inset-0 size-full -rotate-90 transform-gpu"
              aria-hidden="true"
            >
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke="currentColor"
                className="text-background-tertiary-default"
                strokeWidth="3"
              />
              <circle
                cx="12"
                cy="12"
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                className={cn(
                  "text-text-tertiary transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none",
                  isOverloaded && "text-text-error-primary",
                )}
              />
            </svg>
          </span>
        </button>
      </Focusable>
      <Tooltip size="md" placement="top end">
        <ContextWindowDetails usage={usage} providerDisplayName={providerDisplayName} />
      </Tooltip>
    </TooltipTrigger>
  );
}
