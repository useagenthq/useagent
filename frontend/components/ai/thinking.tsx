"use client";

import { RiArrowDownSLine } from "@remixicon/react";
import { type ReactNode, useState } from "react";
import { PixelLoader } from "@/components/ai/loading-state";
import { useReportWorking } from "@/components/shell/working-signal";
import { cx } from "@/utils/cx";

export interface ThinkingProps {
  /** Disclosure label; shimmers while `active`. */
  label?: string;
  /** Muted text after the label: the live step, or a settled count / duration. */
  detail?: string | null;
  /** Steps / reasoning region, mounted only while expanded. */
  children?: ReactNode;
  /** Initial expanded state (uncontrolled). */
  open?: boolean;
  /** Controlled expanded state; pair with `onExpandedChange`. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** While true, the label runs the shimmer sweep and the pixel loader closes
   *  the pill in place of the chevron. Default true. */
  active?: boolean;
  /** Tint the settled label as a failure (a trace with failed steps). */
  failed?: boolean;
  className?: string;
}

/**
 * Collapsible "Thinking" disclosure: one rounded pill reading the label, a
 * muted detail and, at its end, the chevron (or the pixel loader while the
 * agent is still working), over the steps region behind a hairline connector.
 * No leading glyph in any state. The region mounts only while expanded, so a
 * long trace never hits the DOM behind a closed header. Ported from the
 * beautiful-ui Thinking demo onto our semantic tokens.
 */
export function Thinking({
  label = "Thinking",
  detail,
  children,
  open = false,
  expanded: controlled,
  onExpandedChange,
  active = true,
  failed = false,
  className,
}: ThinkingProps) {
  const [uncontrolled, setUncontrolled] = useState(open);
  const expanded = controlled ?? uncontrolled;
  const hasSteps = Boolean(children);
  const toggle = () => {
    if (!hasSteps) return;
    if (controlled === undefined) setUncontrolled(!expanded);
    onExpandedChange?.(!expanded);
  };
  // A live "Thinking" disclosure means the agent is streaming - report it so
  // the brand mark keeps pulsing through the whole turn, not just the boot pill.
  // A settled/folded disclosure passes active={false} and is a no-op.
  useReportWorking(active);

  return (
    <div className={cx("flex w-full flex-col", className)}>
      <button
        type="button"
        aria-expanded={hasSteps ? expanded : undefined}
        onClick={toggle}
        disabled={!hasSteps}
        data-testid="thinking-header"
        className={cx(
          "inline-flex w-fit max-w-full items-center gap-2 rounded-full bg-background-secondary-default px-2.5 py-1 ring-1 ring-inset ring-border-button-default/60 transition-colors duration-100",
          hasSteps ? "cursor-pointer hover:bg-background-secondary-hover" : "cursor-default",
        )}
      >
        {active ? (
          <span className="agent-progress-loading-text shrink-0 text-body-2-medium">{label}</span>
        ) : (
          <span
            className={cx(
              "shrink-0 text-body-2-medium",
              failed ? "text-text-error-primary" : "text-text-secondary",
            )}
          >
            {label}
          </span>
        )}
        {detail && (
          <span className="min-w-0 truncate text-body-2-regular tabular-nums text-text-tertiary">
            {detail}
          </span>
        )}
        {active ? (
          <PixelLoader className="text-text-secondary" />
        ) : (
          hasSteps && (
            <RiArrowDownSLine
              className={cx(
                "size-3.5 shrink-0 text-text-tertiary transition-transform duration-300",
                expanded && "rotate-180",
              )}
              aria-hidden
            />
          )
        )}
      </button>

      {hasSteps && expanded && (
        <div className="animate-ai-fade-up mt-1.5 ml-[11px] border-l border-border-button-default/60 pl-3">
          <div className="flex flex-col gap-px py-0.5">{children}</div>
        </div>
      )}
    </div>
  );
}
