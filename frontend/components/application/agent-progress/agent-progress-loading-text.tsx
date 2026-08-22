"use client";

import { cx } from "@/utils/cx";

type AgentProgressLoadingTextProps = {
  children: string;
  className?: string;
};

/** Reusable loading label with a soft highlight traveling across the text. */
export function AgentProgressLoadingText({
  children,
  className,
}: AgentProgressLoadingTextProps) {
  return (
    <span
      aria-label={children}
      className={cx("agent-progress-loading-text inline-block", className)}
    >
      {children}
    </span>
  );
}
