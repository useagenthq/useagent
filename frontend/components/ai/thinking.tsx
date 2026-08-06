"use client";

import { useState, type ReactNode } from "react";
import { RiArrowDownSLine, RiSparkling2Line } from "@remixicon/react";
import { useReportWorking } from "@/components/shell/working-signal";
import { cnExt as cn } from "@/utils/cn";

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
    <div className={cn("flex w-full flex-col", className)}>
      <button
        type="button"
        aria-expanded={hasSteps ? expanded : undefined}
        onClick={() => hasSteps && setExpanded((e) => !e)}
        disabled={!hasSteps}
        className={cn(
          "-mx-1.5 flex w-fit items-center gap-2 rounded-lg px-1.5 py-1 transition-colors duration-100",
          hasSteps ? "hover:bg-bg-soft-200" : "cursor-default",
        )}
      >
        <RiSparkling2Line
          className="size-4 shrink-0 text-text-sub-600"
          aria-hidden
        />
        {active ? (
          <span className="agent-progress-loading-text text-label-sm">{label}</span>
        ) : (
          <span className="text-label-sm text-text-sub-600">{label}</span>
        )}
        {hasSteps && (
          <RiArrowDownSLine
            className={cn(
              "size-4 shrink-0 text-text-soft-400 transition-transform duration-300",
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
            <div className="mt-1 ml-[7px] border-l border-stroke-soft-200 pl-4">
              <div className="flex flex-col gap-1.5 py-1">{children}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
