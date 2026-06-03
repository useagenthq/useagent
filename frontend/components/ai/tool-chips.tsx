"use client";

import type { ComponentType } from "react";
import { cx } from "@/utils/cx";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export type ToolChipState = "running" | "done" | "error";

export interface ToolChipProps {
  icon: IconComponent;
  label: string;
  /** Optional trailing count ("4 tool calls" style). */
  count?: number;
  state?: ToolChipState;
  className?: string;
}

const tone: Record<ToolChipState, string> = {
  running: "border-border-button-default bg-background-primary-default text-text-secondary",
  done: "border-transparent bg-background-secondary-default text-text-secondary",
  error: "border-transparent bg-status-rose-background text-status-rose-text",
};

/**
 * Inline chip for a single tool call / activity entry. Running chips carry a
 * pulsing dot; errors take the error state tone. Ported from the beautiful-ui
 * ToolChips demo onto our semantic tokens.
 */
export function ToolChip({
  icon: Icon,
  label,
  count,
  state = "done",
  className,
}: ToolChipProps) {
  return (
    <span
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-caption-1-medium",
        tone[state],
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
      {typeof count === "number" && (
        <span className="shrink-0 font-mono text-caption-1-medium tabular-nums opacity-70">
          {count}
        </span>
      )}
      {state === "running" && (
        <span
          className="ml-0.5 size-1.5 shrink-0 animate-pulse rounded-full bg-orange-500"
          aria-hidden
        />
      )}
    </span>
  );
}
