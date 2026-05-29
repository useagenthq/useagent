"use client";

import { RiArrowDownSLine, RiSparkling2Line } from "@remixicon/react";
import { type ReactNode, useState } from "react";
import { useReportWorking } from "@/components/shell/working-signal";
import { cx } from "@/utils/cx";

export interface ThinkingProps {
  /** Disclosure label; shimmers while `active`. */
  label?: string;
  /** Steps / reasoning region, revealed when expanded. */
  children?: ReactNode;
  /** Initial expanded state (uncontrolled). */
  open?: boolean;
  /** While true, the label runs the shimmer sweep. Default true. */
  active?: boolean;
  className?: string;
}

/**
 * Collapsible "Thinking…" disclosure. The label shimmers while the agent is
 * still working (reusing the `.agent-progress-loading-text` sweep); the steps
 * region expands with a grid-rows transition down a hairline connector. Ported
 * from the beautiful-ui Thinking demo onto AlignUI semantic tokens.
 */
export function Thinking({
  label = "Thinking",
  children,
  open = false,
  active = true,
  className,
}: ThinkingProps) {
  const [expanded, setExpanded] = useState(open);
  const hasSteps = Boolean(children);
  // A live "Thinking..." disclosure means the agent is streaming - report it so
  // the brand mark keeps pulsing through the whole turn, not just the boot pill.
  // A settled/folded disclosure passes active={false} and is a no-op.
  useReportWorking(active);

  return (
    <div className={cx("flex w-full flex-col", className)}>
      <button
        type="button"
        aria-expanded={hasSteps ? expanded : undefined}
        onClick={() => hasSteps && setExpanded((e) => !e)}
        disabled={!hasSteps}
        className={cx(
          "-mx-1.5 flex w-fit items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors duration-100",
          hasSteps ? "hover:bg-background-secondary-hover" : "cursor-default",
        )}
      >
        <RiSparkling2Line className="size-3.5 shrink-0 text-text-secondary" aria-hidden />
        {active ? (
          <span className="agent-progress-loading-text text-caption-1-medium">{label}</span>
        ) : (
          <span className="text-caption-1-medium text-text-secondary">{label}</span>
        )}
        {hasSteps && (
          <RiArrowDownSLine
            className={cx(
              "size-3.5 shrink-0 text-text-tertiary transition-transform duration-300",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        )}
      </button>

      {hasSteps && (
        <div
          className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
          style={{
            gridTemplateRows: expanded ? "1fr" : "0fr",
            opacity: expanded ? 1 : 0,
          }}
        >
          <div className="overflow-hidden">
            <div className="mt-1 ml-1.5 border-l border-border-button-default/60 pl-3">
              <div className="flex flex-col gap-1 py-0.5">{children}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
