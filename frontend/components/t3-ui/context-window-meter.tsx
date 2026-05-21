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
//   thread activities; our backend emits no such event, so T3ContextWindowUsage
//   is the minimal prop shape and the percentage is computed HERE from
//   usedTokens/maxTokens (no caller math). Bind real data via
//   contextWindowFromChildUsage in ./adapter.ts.
// - Their hover Popover (tooltipStyle) -> AlignUI Tooltip; the detail panel is
//   the exported T3ContextWindowDetails so it stays SSR-testable and reusable.
// - CSS color-mix ring colors -> semantic token classes with currentColor
//   strokes (track text-bg-soft-200, fill text-text-soft-400, >90% overloaded
//   -> text-error-base).

import * as Tooltip from "@/components/ui/tooltip";
import { cn } from "@/utils/cn";

/** The minimal usage shape the meter renders; maxTokens null = unknown limit. */
export interface T3ContextWindowUsage {
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
export function contextWindowUsedPercentage(usage: T3ContextWindowUsage): number | null {
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
export function T3ContextWindowDetails(props: {
  usage: T3ContextWindowUsage;
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
    <div data-t3-ui="context-window-details" className="flex w-64 flex-col gap-2 text-left">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] font-medium text-text-sub-600">Context Window</div>
        {usage.maxTokens !== null && usedPercentageLabel ? (
          <div className="text-[11px] text-text-soft-400 tabular-nums">
            <span>{usedPercentageLabel}</span>
            <span className="mx-1">·</span>
            <span>
              {formatContextWindowTokens(usage.usedTokens)}/
              {formatContextWindowTokens(usage.maxTokens)}
            </span>
          </div>
        ) : (
          <div className="text-[11px] text-text-soft-400 tabular-nums">
            {formatContextWindowTokens(usage.usedTokens)}
          </div>
        )}
      </div>
      {usage.maxTokens !== null ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-bg-soft-200"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(normalizedPercentage)}
          aria-label="Context window usage"
        >
          <div
            className={cn(
              "h-full rounded-full bg-text-soft-400 transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
              isOverloaded && "bg-error-base",
            )}
            style={{ width: `${normalizedPercentage}%` }}
          />
        </div>
      ) : null}
      {showTotalProcessed ? (
        <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
          <span className="text-text-soft-400">Total processed</span>
          <span className="font-medium text-text-soft-400 tabular-nums">
            {formatContextWindowTokens(totalProcessedTokens)}
          </span>
        </div>
      ) : null}
      {usage.compactsAutomatically ? (
        <div className="mt-1 text-pretty text-[11px] font-medium text-text-soft-400">
          {providerDisplayName ?? "It"} automatically compacts its context when needed.
        </div>
      ) : null}
    </div>
  );
}

/**
 * The slim context-window ring: fills with usage, turns error-red past 90%,
 * and reveals T3ContextWindowDetails on hover. Purely presentational.
 */
export function T3ContextWindowMeter(props: {
  usage: T3ContextWindowUsage;
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
    <Tooltip.Root delayDuration={150}>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          data-t3-ui="context-window-meter"
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full border border-transparent text-text-sub-600 outline-none transition-colors hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base"
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
                className="text-bg-soft-200"
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
                  "text-text-soft-400 transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none",
                  isOverloaded && "text-error-base",
                )}
              />
            </svg>
          </span>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content size="medium" variant="light" side="top" align="end">
        <T3ContextWindowDetails usage={usage} providerDisplayName={providerDisplayName} />
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
